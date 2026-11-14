import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { openWorkspaceParent } from './workspacePathGuard.js'
import { createHash, randomUUID } from 'node:crypto'
import { inflateRaw } from 'node:zlib'
import { promisify } from 'node:util'
import {
  directoryFingerprint,
  directoryIdentity,
  fileFingerprint,
  matchesDirectoryFingerprint,
  matchesDirectoryIdentity,
  matchesFileFingerprint,
  sameFileSnapshot,
} from './zipImportIdentity.js'

const inflateRawAsync = promisify(inflateRaw)
const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const DESCRIPTOR_SIGNATURE = 0x08074b50
const MAX_COMMENT_BYTES = 0xffff
const DEFAULT_LIMITS = Object.freeze({
  maxArchiveBytes: 100 * 1024 * 1024,
  maxEntries: 5000,
  maxImportedFiles: 1000,
  maxFileBytes: 50 * 1024 * 1024,
  maxExpandedBytes: 250 * 1024 * 1024,
  maxCompressionRatio: 500,
})
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'tif'])
const CRC_TABLE = new Uint32Array(256)

for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
  CRC_TABLE[index] = value >>> 0
}

function zipError(message, code = 'INVALID_ARCHIVE') {
  const error = new Error(message)
  error.code = code
  return error
}

function assertRange(buffer, offset, length, message = '压缩包结构无效') {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
    throw zipError(message)
  }
}

function readU32(buffer, offset) {
  assertRange(buffer, offset, 4)
  return buffer.readUInt32LE(offset)
}

function findEndRecord(buffer) {
  const minimum = Math.max(0, buffer.length - (22 + MAX_COMMENT_BYTES))
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIGNATURE) continue
    const commentLength = buffer.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength === buffer.length) return offset
  }
  throw zipError('压缩包缺少有效的结束记录')
}

function decodeName(bytes, flags) {
  if ((flags & 0x0800) === 0 && bytes.some(byte => byte > 0x7f)) {
    throw zipError('压缩包文件名未标记为 UTF-8，无法安全识别')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw zipError('压缩包包含无效的 UTF-8 文件名')
  }
}

function parseExtraFields(buffer) {
  const fields = []
  let offset = 0
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw zipError('压缩包扩展字段无效')
    const id = buffer.readUInt16LE(offset)
    const size = buffer.readUInt16LE(offset + 2)
    offset += 4
    if (offset + size > buffer.length) throw zipError('压缩包扩展字段无效')
    if (id === 0x0001 || id === 0x7075) throw zipError('暂不支持 ZIP64 或 Unicode 路径扩展字段')
    fields.push({ id, data: buffer.subarray(offset, offset + size) })
    offset += size
  }
  return fields
}

function archivePath(rawName, isDirectory) {
  if (!rawName || rawName.includes('\0') || rawName.includes('\\')) throw zipError('压缩包包含非法路径')
  if (rawName.startsWith('/') || /^[a-zA-Z]:/.test(rawName)) throw zipError('压缩包包含绝对路径')
  const withoutDirectorySlash = isDirectory && rawName.endsWith('/') ? rawName.slice(0, -1) : rawName
  const withoutDotPrefix = withoutDirectorySlash.replace(/^(\.\/)+/, '')
  if (!withoutDotPrefix) throw zipError('压缩包包含空路径')
  const pieces = withoutDotPrefix.split('/')
  if (pieces.some(piece => !piece || piece === '.' || piece === '..')) throw zipError('压缩包包含路径穿越条目')
  for (const piece of pieces) {
    if (/[:<>"|?*\u0000-\u001f]/.test(piece) || /[. ]$/.test(piece) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(piece)) {
      throw zipError('压缩包包含当前平台不支持的文件名')
    }
  }
  return pieces.join('/')
}

function isWindowsLikeName(name) {
  return process.platform === 'win32' || process.platform === 'darwin'
}

function normalizedKey(name) {
  return isWindowsLikeName(name) ? name.toLocaleLowerCase('en-US') : name
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function parseEndRecord(buffer, limits) {
  const eocd = findEndRecord(buffer)
  const diskNumber = buffer.readUInt16LE(eocd + 4)
  const centralDisk = buffer.readUInt16LE(eocd + 6)
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8)
  const entryCount = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) throw zipError('不支持多卷 ZIP 压缩包')
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw zipError('暂不支持 ZIP64 压缩包')
  }
  if (entryCount > limits.maxEntries) throw zipError('压缩包条目数量超过限制', 'ZIP_LIMIT')
  if (centralOffset + centralSize > eocd) throw zipError('压缩包中央目录位置无效')
  return { entryCount, centralOffset, centralEnd: centralOffset + centralSize, eocd }
}

function parseLocalRecord(buffer, centralEntry, centralOffset) {
  const { localOffset, rawName, flags, method, crc, compressedSize, uncompressedSize } = centralEntry
  assertRange(buffer, localOffset, 30)
  if (readU32(buffer, localOffset) !== LOCAL_SIGNATURE) throw zipError('压缩包本地文件头无效')
  const localFlags = buffer.readUInt16LE(localOffset + 6)
  const localMethod = buffer.readUInt16LE(localOffset + 8)
  const localCrc = buffer.readUInt32LE(localOffset + 14)
  const localCompressed = buffer.readUInt32LE(localOffset + 18)
  const localUncompressed = buffer.readUInt32LE(localOffset + 22)
  const nameLength = buffer.readUInt16LE(localOffset + 26)
  const extraLength = buffer.readUInt16LE(localOffset + 28)
  assertRange(buffer, localOffset + 30, nameLength + extraLength)
  const localName = buffer.subarray(localOffset + 30, localOffset + 30 + nameLength)
  const localExtra = buffer.subarray(localOffset + 30 + nameLength, localOffset + 30 + nameLength + extraLength)
  parseExtraFields(localExtra)
  if (!localName.equals(rawName) || localFlags !== flags || localMethod !== method) {
    throw zipError('压缩包本地文件头与中央目录不一致')
  }
  const hasDescriptor = (flags & 0x0008) !== 0
  if (hasDescriptor) {
    if ((localCrc !== 0 && localCrc !== crc) || (localCompressed !== 0 && localCompressed !== compressedSize) ||
      (localUncompressed !== 0 && localUncompressed !== uncompressedSize)) {
      throw zipError('压缩包本地文件尺寸信息不一致')
    }
  } else if (localCrc !== crc || localCompressed !== compressedSize || localUncompressed !== uncompressedSize) {
    throw zipError('压缩包本地文件尺寸信息不一致')
  }
  const dataOffset = localOffset + 30 + nameLength + extraLength
  const dataEnd = dataOffset + compressedSize
  if (dataEnd > centralOffset) throw zipError('压缩包文件数据越界或与中央目录重叠')
  let recordEnd = dataEnd
  if (hasDescriptor) {
    assertRange(buffer, recordEnd, 12)
    let descriptorOffset = recordEnd
    if (readU32(buffer, descriptorOffset) === DESCRIPTOR_SIGNATURE) descriptorOffset += 4
    assertRange(buffer, descriptorOffset, 12)
    const descriptorCrc = buffer.readUInt32LE(descriptorOffset)
    const descriptorCompressed = buffer.readUInt32LE(descriptorOffset + 4)
    const descriptorUncompressed = buffer.readUInt32LE(descriptorOffset + 8)
    if (descriptorCrc !== crc || descriptorCompressed !== compressedSize || descriptorUncompressed !== uncompressedSize) {
      throw zipError('压缩包数据描述符与中央目录不一致')
    }
    recordEnd = descriptorOffset + 12
    if (recordEnd > centralOffset) throw zipError('压缩包数据描述符越界')
  }
  return { dataOffset, dataEnd, recordStart: localOffset, recordEnd }
}

function parseEntries(buffer, limits) {
  const end = parseEndRecord(buffer, limits)
  let offset = end.centralOffset
  const entries = []
  const allPaths = new Set()
  let expandedBytes = 0
  const ranges = []

  for (let index = 0; index < end.entryCount; index += 1) {
    assertRange(buffer, offset, 46)
    if (readU32(buffer, offset) !== CENTRAL_SIGNATURE) throw zipError('压缩包中央目录无效')
    const versionMadeBy = buffer.readUInt16LE(offset + 4)
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const crc = buffer.readUInt32LE(offset + 16)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const diskStart = buffer.readUInt16LE(offset + 34)
    const externalAttributes = buffer.readUInt32LE(offset + 38)
    const localOffset = buffer.readUInt32LE(offset + 42)
    if ([compressedSize, uncompressedSize, localOffset].includes(0xffffffff)) throw zipError('暂不支持 ZIP64 压缩包')
    if (diskStart !== 0) throw zipError('不支持多卷 ZIP 压缩包')
    if (method !== 0 && method !== 8) throw zipError(`不支持 ZIP 压缩方法 ${method}`)
    const supportedFlags = 0x0800 | 0x0008 | (method === 8 ? 0x0006 : 0)
    if ((flags & ~supportedFlags) !== 0) throw zipError('不支持 ZIP 通用标志位组合')
    const nameStart = offset + 46
    assertRange(buffer, nameStart, nameLength + extraLength + commentLength)
    const rawName = buffer.subarray(nameStart, nameStart + nameLength)
    const name = decodeName(rawName, flags)
    const extraStart = nameStart + nameLength
    parseExtraFields(buffer.subarray(extraStart, extraStart + extraLength))
    const mode = externalAttributes >>> 16
    const unixHost = (versionMadeBy >>> 8) === 3 || (versionMadeBy >>> 8) === 19
    const unixType = unixHost ? mode & 0xf000 : 0
    const dosDirectory = (externalAttributes & 0x10) !== 0
    const isDirectory = name.endsWith('/') || dosDirectory || unixType === 0x4000
    if (unixType && unixType !== 0x4000 && unixType !== 0x8000) throw zipError('不支持 ZIP 中的符号链接或特殊文件')
    if (isDirectory && (compressedSize !== 0 || uncompressedSize !== 0)) throw zipError('目录条目不能包含文件数据')
    const normalized = archivePath(name, isDirectory)
    const key = normalizedKey(normalized)
    if (allPaths.has(key)) throw zipError(`压缩包包含重复路径：${normalized}`, 'CONFLICT')
    allPaths.add(key)

    if (!isDirectory) {
      expandedBytes += uncompressedSize
      if (uncompressedSize > limits.maxFileBytes || expandedBytes > limits.maxExpandedBytes) {
        throw zipError('压缩包解压大小超过限制', 'ZIP_LIMIT')
      }
      if (uncompressedSize > 0 && (compressedSize === 0 || uncompressedSize / compressedSize > limits.maxCompressionRatio)) {
        throw zipError('压缩包压缩率超过限制', 'ZIP_LIMIT')
      }
    }
    const local = parseLocalRecord(buffer, { localOffset, rawName, flags, method, crc, compressedSize, uncompressedSize }, end.centralOffset)
    ranges.push(local)
    const extension = path.posix.extname(normalized).toLowerCase().slice(1)
    const hidden = normalized.split('/').some(piece => piece.startsWith('.'))
    const ignoredMacMetadata = normalized === '__MACOSX' || normalized.startsWith('__MACOSX/')
    const importable = !isDirectory && !hidden && !ignoredMacMetadata && (extension === 'md' || IMAGE_EXTENSIONS.has(extension))
    if (importable) entries.push({ rawName, name: normalized, flags, method, crc, compressedSize, uncompressedSize, ...local })
    offset = nameStart + nameLength + extraLength + commentLength
  }

  if (offset > end.centralEnd) throw zipError('压缩包中央目录长度不一致')
  // ZIP permits a short central-directory digital signature after the entries.
  if (offset !== end.centralEnd) {
    if (offset + 6 > end.centralEnd || readU32(buffer, offset) !== 0x05054b50) throw zipError('压缩包中央目录长度不一致')
    const signatureSize = buffer.readUInt16LE(offset + 4)
    if (offset + 6 + signatureSize !== end.centralEnd) throw zipError('压缩包中央目录长度不一致')
  }
  ranges.sort((left, right) => left.recordStart - right.recordStart)
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].recordStart < ranges[index - 1].recordEnd) throw zipError('压缩包条目数据区域重叠')
  }
  if (!entries.length) throw zipError('压缩包中没有可导入的 .md 或图片文件')
  if (entries.length > limits.maxImportedFiles) throw zipError('压缩包文件数量超过限制', 'ZIP_LIMIT')
  const selectedNames = new Set(entries.map(entry => normalizedKey(entry.name)))
  for (const entry of entries) {
    const parts = entry.name.split('/')
    for (let index = 1; index < parts.length; index += 1) {
      if (selectedNames.has(normalizedKey(parts.slice(0, index).join('/')))) {
        throw zipError(`压缩包文件与目录路径冲突：${entry.name}`, 'CONFLICT')
      }
    }
  }
  return entries
}

async function extractEntry(buffer, entry, limits) {
  const compressed = buffer.subarray(entry.dataOffset, entry.dataEnd)
  let data
  if (entry.method === 0) {
    data = compressed
  } else {
    try {
      data = await inflateRawAsync(compressed, { maxOutputLength: Math.min(limits.maxFileBytes, entry.uncompressedSize + 1) })
    } catch (error) {
      throw zipError(`无法解压条目 ${entry.name}: ${error.message}`)
    }
  }
  if (data.length !== entry.uncompressedSize) throw zipError(`条目尺寸与中央目录不一致：${entry.name}`)
  if (data.length > limits.maxFileBytes) throw zipError('压缩包单文件解压大小超过限制', 'ZIP_LIMIT')
  if (crc32(data) !== entry.crc) throw zipError(`条目 CRC 校验失败：${entry.name}`)
  return data
}

function within(base, target) {
  const relative = path.relative(base, target)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

async function validateExistingParents(base, targetDirectory) {
  if (!within(base, targetDirectory)) throw zipError('压缩包路径超出工作空间')
  const relative = path.relative(base, targetDirectory)
  let current = base
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part)
    try {
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw zipError('导入目录包含非法符号链接或文件')
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
  }
}

const READ_FILE_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function rememberDirectory(directoryPath, stat, directoryMap, directoryList) {
  const record = {
    path: directoryPath,
    identity: directoryIdentity(stat),
    fingerprint: directoryFingerprint(stat),
    children: new Set(),
  }
  directoryMap.set(directoryPath, record)
  directoryList.push(record)
  return record
}

async function assertTrackedDirectory(directoryPath, directoryMap) {
  const record = directoryMap.get(directoryPath)
  if (!record) return
  const stat = await fs.lstat(directoryPath, { bigint: true })
  if (!matchesDirectoryFingerprint(stat, record.fingerprint)) throw zipError('导入目录在操作期间发生变化')
  const children = await fs.readdir(directoryPath)
  if (children.length !== record.children.size || children.some(child => !record.children.has(child))) {
    throw zipError('导入目录包含并发创建的内容')
  }
}

async function refreshTrackedDirectory(directoryPath, directoryMap) {
  const record = directoryMap.get(directoryPath)
  if (!record) return
  const stat = await fs.lstat(directoryPath, { bigint: true })
  if (!matchesDirectoryIdentity(stat, record.identity)) throw zipError('导入目录在操作期间发生变化')
  record.fingerprint = directoryFingerprint(stat)
  const children = await fs.readdir(directoryPath)
  if (children.length !== record.children.size || children.some(child => !record.children.has(child))) {
    throw zipError('导入目录包含并发创建的内容')
  }
}

async function noteTrackedChild(parentPath, childName, directoryMap) {
  const record = directoryMap.get(parentPath)
  if (!record) return
  if (record.children.has(childName)) throw zipError('导入目录目标已存在', 'CONFLICT')
  record.children.add(childName)
  await refreshTrackedDirectory(parentPath, directoryMap)
}

async function forgetTrackedChild(parentPath, childName, directoryMap) {
  const record = directoryMap.get(parentPath)
  if (!record) return
  record.children.delete(childName)
  await refreshTrackedDirectory(parentPath, directoryMap)
}

async function makeDirectories(base, targetDirectory, createdDirectories, directoryMap) {
  if (!within(base, targetDirectory)) throw zipError('压缩包路径超出工作空间')
  const relative = path.relative(base, targetDirectory)
  let current = base
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part)
    const parent = path.dirname(current)
    await assertTrackedDirectory(parent, directoryMap)
    let stat
    try {
      stat = await fs.lstat(current, { bigint: true })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const guard = await openWorkspaceParent(base, current, zipError)
      try {
        await guard.check()
        await assertTrackedDirectory(parent, directoryMap)
        try {
          await fs.mkdir(current, { mode: 0o700 })
          stat = await fs.lstat(current, { bigint: true })
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw zipError('导入目录包含非法符号链接或文件')
          await noteTrackedChild(parent, path.basename(current), directoryMap)
          rememberDirectory(current, stat, directoryMap, createdDirectories)
        } catch (mkdirError) {
          if (mkdirError.code !== 'EEXIST') throw mkdirError
          stat = await fs.lstat(current, { bigint: true })
        }
      } finally {
        await guard.close()
      }
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw zipError('导入目录包含非法符号链接或文件')
    await assertTrackedDirectory(current, directoryMap)
  }
}

async function inspectOpenFile(filePath, handle, maxBytes, includeData = false) {
  const before = await handle.stat({ bigint: true })
  const beforePath = await fs.lstat(filePath, { bigint: true })
  if (!sameFileSnapshot(before, beforePath)) throw zipError('导入文件在读取前已变化')
  if (before.size > BigInt(maxBytes) || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw zipError('ZIP 回滚文件超过可验证大小上限')
  }

  const size = Number(before.size)
  const data = includeData ? Buffer.alloc(size) : undefined
  const chunk = includeData ? data : Buffer.allocUnsafe(64 * 1024)
  const digest = createHash('sha256')
  let position = 0
  while (position < size) {
    const length = Math.min(chunk.length, size - position)
    const { bytesRead } = await handle.read(chunk, includeData ? position : 0, length, position)
    if (!bytesRead) throw zipError('导入文件在读取期间发生变化')
    digest.update(chunk.subarray(includeData ? position : 0, (includeData ? position : 0) + bytesRead))
    position += bytesRead
  }

  const after = await handle.stat({ bigint: true })
  const afterPath = await fs.lstat(filePath, { bigint: true })
  if (!sameFileSnapshot(before, after) || !sameFileSnapshot(before, afterPath)) {
    throw zipError('导入文件在读取期间发生变化')
  }
  return { stat: after, sha256: digest.digest('hex'), data }
}

async function writeTrackedStagingFile(base, destination, content, stagingFiles, directoryMap) {
  const guard = await openWorkspaceParent(base, destination, zipError)
  let handle
  try {
    await guard.check()
    await assertTrackedDirectory(path.dirname(destination), directoryMap)
    handle = await fs.open(destination, 'wx+', 0o600)
    let writeError
    try {
      await handle.writeFile(content)
    } catch (error) {
      writeError = error
    }
    const observed = await inspectOpenFile(destination, handle, content.length)
    const record = { kind: 'file', path: destination, fingerprint: fileFingerprint(observed.stat, observed.sha256) }
    stagingFiles.push(record)
    await noteTrackedChild(path.dirname(destination), path.basename(destination), directoryMap)
    if (writeError) throw writeError
    if (observed.sha256 !== sha256(content)) throw zipError('ZIP 暂存文件写入内容不一致')
    return record
  } finally {
    await handle?.close().catch(() => {})
    await guard.close()
  }
}

const UNAVAILABLE_HARDLINK_ERRORS = new Set(['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EACCES', 'EMLINK'])

async function writeExclusive(base, destination, content, createdFiles, stagingDirectory, stagingFiles,
  workspaceDirectories, stagingDirectories, options) {
  const guard = await openWorkspaceParent(base, destination, zipError)
  let handle
  const record = { path: destination, fingerprint: null, anchorPath: null, anchorIdentity: null }
  createdFiles.push(record)
  try {
    await guard.check()
    await assertTrackedDirectory(path.dirname(destination), workspaceDirectories)
    handle = await fs.open(destination, 'wx+', 0o600)
    const empty = await inspectOpenFile(destination, handle, content.length)
    if (empty.stat.size !== 0n) throw zipError('新建导入文件并非空文件')

    let writeError
    try {
      if (typeof options.writeFileForTest === 'function') {
        await options.writeFileForTest(handle, content, path.basename(destination))
      } else {
        await handle.writeFile(content)
      }
    } catch (error) {
      writeError = error
    }

    const beforeLink = await inspectOpenFile(destination, handle, content.length)
    const anchorPath = path.join(stagingDirectory, `.rollback-${randomUUID()}.link`)
    const anchorGuard = await openWorkspaceParent(base, anchorPath, zipError)
    try {
      await anchorGuard.check()
      await assertTrackedDirectory(stagingDirectory, stagingDirectories)
      let linkError
      try {
        if (typeof options.linkForRollbackForTest === 'function') {
          await options.linkForRollbackForTest(destination, anchorPath)
        } else {
          await fs.link(destination, anchorPath)
        }
      } catch (error) {
        linkError = error
      }

      if (linkError && !UNAVAILABLE_HARDLINK_ERRORS.has(linkError.code)) throw linkError
      if (!linkError) {
        const anchorStat = await fs.lstat(anchorPath, { bigint: true })
        if (!anchorStat.isFile() || anchorStat.isSymbolicLink() || anchorStat.dev !== beforeLink.stat.dev ||
          anchorStat.ino !== beforeLink.stat.ino) {
          throw zipError('ZIP 回滚锚点身份不匹配')
        }
        record.anchorPath = anchorPath
        record.anchorIdentity = { dev: anchorStat.dev, ino: anchorStat.ino, modeType: anchorStat.mode & 0o170000n }
        stagingFiles.push({ kind: 'anchor', path: anchorPath, identity: record.anchorIdentity })
        await noteTrackedChild(stagingDirectory, path.basename(anchorPath), stagingDirectories)

        const anchorHandle = await fs.open(anchorPath, READ_FILE_FLAGS)
        try {
          const afterLink = await inspectOpenFile(destination, handle, content.length)
          const anchorObserved = await inspectOpenFile(anchorPath, anchorHandle, content.length)
          const sourceStayedStable = afterLink.stat.dev === beforeLink.stat.dev &&
            afterLink.stat.ino === beforeLink.stat.ino && afterLink.stat.size === beforeLink.stat.size &&
            afterLink.stat.mtimeNs === beforeLink.stat.mtimeNs && afterLink.sha256 === beforeLink.sha256
          if (!sourceStayedStable || !sameFileSnapshot(afterLink.stat, anchorObserved.stat) ||
            afterLink.sha256 !== anchorObserved.sha256) {
            throw zipError('ZIP 回滚锚点创建期间文件发生变化')
          }
          record.fingerprint = fileFingerprint(afterLink.stat, afterLink.sha256)
        } finally {
          await anchorHandle.close().catch(() => {})
        }
        await refreshTrackedDirectory(stagingDirectory, stagingDirectories)
      } else {
        // Hard links are unavailable on some filesystems. Imports still succeed;
        // rollback will preserve this path because a hash is not a durable file identity.
        const afterWrite = await inspectOpenFile(destination, handle, content.length)
        record.fingerprint = fileFingerprint(afterWrite.stat, afterWrite.sha256)
      }
    } finally {
      await anchorGuard.close()
    }

    if (!record.fingerprint) throw zipError('无法记录 ZIP 导入文件身份')
    await noteTrackedChild(path.dirname(destination), path.basename(destination), workspaceDirectories)
    if (writeError) throw writeError
    if (record.fingerprint.sha256 !== sha256(content)) throw zipError('ZIP 导入文件写入内容不一致')
  } finally {
    await handle?.close().catch(() => {})
    await guard.close()
  }
}

function sameFileIdentity(stat, expected) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.dev === expected.dev && stat.ino === expected.ino &&
    (stat.mode & 0o170000n) === expected.modeType
}

async function removeCreatedFile(base, entry, workspaceDirectories, stagingDirectories) {
  if (!entry.fingerprint || !entry.anchorPath || !entry.anchorIdentity) return false
  let guard
  let handle
  let anchorGuard
  let anchorHandle
  try {
    guard = await openWorkspaceParent(base, entry.path, zipError)
    await guard.check()
    await assertTrackedDirectory(path.dirname(entry.path), workspaceDirectories)
    handle = await fs.open(entry.path, READ_FILE_FLAGS)
    const current = await inspectOpenFile(entry.path, handle, Number(entry.fingerprint.size))
    if (!matchesFileFingerprint(current.stat, entry.fingerprint, current.sha256)) return false

    anchorGuard = await openWorkspaceParent(base, entry.anchorPath, zipError)
    await anchorGuard.check()
    await assertTrackedDirectory(path.dirname(entry.anchorPath), stagingDirectories)
    anchorHandle = await fs.open(entry.anchorPath, READ_FILE_FLAGS)
    const anchor = await inspectOpenFile(entry.anchorPath, anchorHandle, Number(entry.fingerprint.size))
    if (!matchesFileFingerprint(anchor.stat, entry.fingerprint, anchor.sha256) ||
      !sameFileSnapshot(current.stat, anchor.stat) || current.sha256 !== anchor.sha256) return false

    await guard.check()
    await assertTrackedDirectory(path.dirname(entry.path), workspaceDirectories)
    const finalPathStat = await fs.lstat(entry.path, { bigint: true })
    if (!matchesFileFingerprint(finalPathStat, entry.fingerprint, current.sha256)) return false
    await fs.unlink(entry.path)
    await forgetTrackedChild(path.dirname(entry.path), path.basename(entry.path), workspaceDirectories)
    return true
  } catch {
    return false
  } finally {
    await anchorHandle?.close().catch(() => {})
    await anchorGuard?.close()
    await handle?.close().catch(() => {})
    await guard?.close()
  }
}

async function removeCreatedDirectory(base, record, directoryMap) {
  let guard
  try {
    guard = await openWorkspaceParent(base, record.path, zipError)
    await guard.check()
    await assertTrackedDirectory(record.path, directoryMap)
    if (record.children.size !== 0) return false
    const parent = path.dirname(record.path)
    await assertTrackedDirectory(parent, directoryMap)
    await fs.rmdir(record.path)
    directoryMap.delete(record.path)
    await forgetTrackedChild(parent, path.basename(record.path), directoryMap)
    return true
  } catch {
    return false
  } finally {
    await guard?.close()
  }
}

async function removeStagingFile(base, record, directoryMap) {
  let guard
  let handle
  try {
    guard = await openWorkspaceParent(base, record.path, zipError)
    await guard.check()
    const parentPath = path.dirname(record.path)
    await assertTrackedDirectory(parentPath, directoryMap)
    const stat = await fs.lstat(record.path, { bigint: true })
    if (record.kind === 'anchor') {
      if (!sameFileIdentity(stat, record.identity)) return false
    } else {
      handle = await fs.open(record.path, READ_FILE_FLAGS)
      const current = await inspectOpenFile(record.path, handle, Number(record.fingerprint.size))
      if (!matchesFileFingerprint(current.stat, record.fingerprint, current.sha256)) return false
    }
    await guard.check()
    await assertTrackedDirectory(parentPath, directoryMap)
    await fs.unlink(record.path)
    await forgetTrackedChild(parentPath, path.basename(record.path), directoryMap)
    return true
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => {})
    await guard?.close()
  }
}

async function cleanupStaging(base, stagingFiles, stagingDirectories, stagingDirectoryMap) {
  const warnings = []
  for (const record of [...stagingFiles].reverse()) {
    if (!await removeStagingFile(base, record, stagingDirectoryMap) && await pathExists(record.path)) {
      warnings.push(record.path)
    }
  }
  for (const record of [...stagingDirectories].reverse()) {
    if (!await removeCreatedDirectory(base, record, stagingDirectoryMap) && await pathExists(record.path)) {
      warnings.push(record.path)
    }
  }
  return warnings
}

async function readTrackedStagingFile(base, record, directoryMap, maxBytes) {
  const guard = await openWorkspaceParent(base, record.path, zipError)
  let handle
  try {
    await guard.check()
    await assertTrackedDirectory(path.dirname(record.path), directoryMap)
    handle = await fs.open(record.path, READ_FILE_FLAGS)
    const observed = await inspectOpenFile(record.path, handle, maxBytes, true)
    if (!matchesFileFingerprint(observed.stat, record.fingerprint, observed.sha256)) {
      throw zipError('ZIP 暂存文件在提交前发生变化')
    }
    return observed.data
  } finally {
    await handle?.close().catch(() => {})
    await guard.close()
  }
}

async function pathExists(target) {
  try {
    await fs.lstat(target)
    return true
  } catch (error) {
    return error.code !== 'ENOENT'
  }
}

function addRollbackDiagnostics(error, paths, base) {
  const unique = [...new Set(paths)].map(target => path.relative(base, target) || '.')
  if (!unique.length) return error
  const diagnostic = error instanceof Error ? error : new Error(String(error))
  diagnostic.rollbackWarnings = unique
  diagnostic.message = `${diagnostic.message}；为避免误删，回滚保留了无法确认身份的路径：${unique.join('、')}`
  return diagnostic
}

function mergeLimits(options) {
  const limits = { ...DEFAULT_LIMITS }
  for (const name of Object.keys(limits)) {
    if (options[name] != null) {
      const value = Number(options[name])
      if (!Number.isSafeInteger(value) || value <= 0) throw zipError(`ZIP 限制参数无效：${name}`, 'INVALID_OPTIONS')
      limits[name] = value
    }
  }
  return limits
}

/**
 * Import Markdown and supported image files from a ZIP archive without an
 * external unzip executable. ZIP64, encryption, multi-volume archives,
 * symlinks, special files and unsupported compression methods are rejected.
 */
export async function importZip(workspace, archive, options = {}) {
  if (typeof workspace !== 'string' || !workspace) throw zipError('缺少工作空间', 'INVALID_WORKSPACE')
  if (!Buffer.isBuffer(archive) && !(archive instanceof Uint8Array)) throw zipError('压缩包内容无效')
  const buffer = Buffer.isBuffer(archive) ? archive : Buffer.from(archive)
  const limits = mergeLimits(options)
  if (buffer.length === 0) throw zipError('压缩包不能为空')
  if (buffer.length > limits.maxArchiveBytes) throw zipError('压缩包大小超过限制', 'ZIP_LIMIT')
  const entries = parseEntries(buffer, limits)
  const realWorkspace = await fs.realpath(workspace)
  const rootStat = await fs.stat(realWorkspace)
  if (!rootStat.isDirectory()) throw zipError('工作空间不是目录', 'INVALID_WORKSPACE')

  const normalizedDestinations = new Set()
  const destinations = entries.map(entry => {
    const destination = path.resolve(realWorkspace, ...entry.name.split('/'))
    if (!within(realWorkspace, destination)) throw zipError('压缩包路径超出工作空间')
    const key = normalizedKey(path.relative(realWorkspace, destination).split(path.sep).join('/'))
    if (normalizedDestinations.has(key)) throw zipError(`压缩包包含重复目标：${entry.name}`, 'CONFLICT')
    normalizedDestinations.add(key)
    return { entry, destination }
  })

  // Check all collisions and symlinked parents before staging any data.
  for (const { entry, destination } of destinations) {
    await validateExistingParents(realWorkspace, path.dirname(destination))
    try {
      await fs.lstat(destination)
      throw zipError(`导入目标已存在：${entry.name}`, 'CONFLICT')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  const stagingDirectory = path.join(realWorkspace, `.standalone-editor-import-${randomUUID()}.staging`)
  const stagingGuard = await openWorkspaceParent(realWorkspace, stagingDirectory, zipError)
  let stagingStat
  try {
    await stagingGuard.check()
    await fs.mkdir(stagingDirectory, { mode: 0o700 })
    stagingStat = await fs.lstat(stagingDirectory, { bigint: true })
  } finally {
    await stagingGuard.close()
  }
  const createdFiles = []
  const createdDirectories = []
  const workspaceDirectoryMap = new Map()
  const stagingFiles = []
  const stagingDirectories = []
  const stagingDirectoryMap = new Map()
  rememberDirectory(stagingDirectory, stagingStat, stagingDirectoryMap, stagingDirectories)
  let result
  let failure
  const rollbackWarnings = []
  try {
    const staged = []
    for (const { entry, destination } of destinations) {
      const data = await extractEntry(buffer, entry, limits)
      const stagedPath = path.resolve(stagingDirectory, ...entry.name.split('/'))
      if (!within(stagingDirectory, stagedPath)) throw zipError('暂存路径无效')
      await makeDirectories(stagingDirectory, path.dirname(stagedPath), stagingDirectories, stagingDirectoryMap)
      const stagingRecord = await writeTrackedStagingFile(
        stagingDirectory, stagedPath, data, stagingFiles, stagingDirectoryMap)
      staged.push({ entry, destination, stagingRecord })
    }

    for (const { entry, destination, stagingRecord } of staged) {
      await makeDirectories(realWorkspace, path.dirname(destination), createdDirectories, workspaceDirectoryMap)
      if (typeof options.beforeCommitFile === 'function') await options.beforeCommitFile(entry.name)
      const data = await readTrackedStagingFile(
        stagingDirectory, stagingRecord, stagingDirectoryMap, limits.maxFileBytes)
      await writeExclusive(realWorkspace, destination, data, createdFiles, stagingDirectory, stagingFiles,
        workspaceDirectoryMap, stagingDirectoryMap, options)
    }
    result = { imported: staged.length, files: staged.map(item => item.entry.name) }
  } catch (error) {
    failure = error
    for (const file of [...createdFiles].reverse()) {
      const removed = await removeCreatedFile(realWorkspace, file, workspaceDirectoryMap, stagingDirectoryMap)
      if (!removed && await pathExists(file.path)) rollbackWarnings.push(file.path)
    }
    for (const directory of [...createdDirectories].reverse()) {
      const removed = await removeCreatedDirectory(realWorkspace, directory, workspaceDirectoryMap)
      if (!removed && await pathExists(directory.path)) rollbackWarnings.push(directory.path)
    }
  }

  const stagingWarnings = await cleanupStaging(
    realWorkspace, stagingFiles, stagingDirectories, stagingDirectoryMap)
  if (failure) {
    failure = addRollbackDiagnostics(failure, [...rollbackWarnings, ...stagingWarnings], realWorkspace)
    throw failure
  }
  if (stagingWarnings.length) {
    console.warn(`ZIP 导入暂存目录包含无法确认归属的内容，已保留：${stagingWarnings.map(file => path.relative(realWorkspace, file)).join('、')}`)
  }
  const cleanupWarnings = [...new Set(stagingWarnings.map(file =>
    path.relative(realWorkspace, file).split(path.sep).join('/')))]
  return { ...result, cleanupWarnings }
}

export const zipImportLimits = DEFAULT_LIMITS
