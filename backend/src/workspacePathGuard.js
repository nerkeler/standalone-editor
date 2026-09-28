import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'

// Node does not expose openat/renameat. Keep descriptors for every directory
// component and compare their identities with the pathname immediately before
// a mutation. This catches a parent replaced after the initial path check.
export async function openWorkspaceParent(base, target, errorFactory) {
  const parent = path.dirname(target)
  const relative = path.relative(base, parent)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw errorFactory('路径超出工作空间')
  }
  const paths = [base]
  for (const part of relative ? relative.split(path.sep) : []) {
    paths.push(path.join(paths.at(-1), part))
  }
  const handles = []
  const flags = constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0)
  try {
    for (const current of paths) {
      // Windows does not provide portable directory handles through fs.open.
      // The pathname identity check below remains available there.
      if (process.platform === 'win32') {
        handles.push({ current, handle: null, stat: await fs.lstat(current) })
      } else {
        const handle = await fs.open(current, flags)
        handles.push({ current, handle, stat: await handle.stat() })
      }
    }
    const check = async () => {
      for (const { current, stat } of handles) {
        let pathStat
        let real
        try {
          pathStat = await fs.lstat(current)
          real = await fs.realpath(current)
        } catch {
          throw errorFactory('目录在操作期间发生变化')
        }
        if (!pathStat.isDirectory() || pathStat.isSymbolicLink() ||
          pathStat.dev !== stat.dev || pathStat.ino !== stat.ino || real !== current) {
          throw errorFactory('目录在操作期间发生变化')
        }
      }
    }
    await check()
    return {
      check,
      async close() {
        await Promise.all(handles.map(({ handle }) => handle?.close().catch(() => {})))
      },
    }
  } catch (error) {
    await Promise.all(handles.map(({ handle }) => handle?.close().catch(() => {})))
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) {
      throw errorFactory('目录在操作期间发生变化')
    }
    throw error
  }
}

export async function assertSameEntry(target, expected, errorFactory) {
  let current
  try {
    current = await fs.lstat(target)
  } catch {
    throw errorFactory('文件在操作期间发生变化')
  }
  if (current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino ||
    current.isDirectory() !== expected.isDirectory() || current.isFile() !== expected.isFile()) {
    throw errorFactory('文件在操作期间发生变化')
  }
}

// A hard link publishes a regular file only when the destination name is free.
// For a directory, an exclusive empty-directory reservation closes the usual
// check-then-rename collision window on POSIX. A concurrent nonempty directory
// makes rename fail; Windows already refuses to rename over a directory.
export async function moveEntryNoReplace(source, destination, expected, {
  check,
  errorFactory,
  conflictFactory,
  rename = fs.rename,
  link = fs.link,
}) {
  await check()
  await assertSameEntry(source, expected, errorFactory)
  if (expected.isFile()) {
    try {
      await link(source, destination)
    } catch (error) {
      if (error.code === 'EEXIST') throw conflictFactory()
      if (['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EMLINK'].includes(error.code)) {
        await copyFileNoReplace(source, destination, expected, { check, errorFactory, conflictFactory })
        return
      }
      throw error
    }
    try {
      await check()
      await assertSameEntry(source, expected, errorFactory)
      await assertSameEntry(destination, expected, errorFactory)
      await fs.unlink(source)
    } catch (error) {
      try {
        await check()
        await assertSameEntry(destination, expected, errorFactory)
        await fs.unlink(destination)
      } catch {}
      throw error
    }
    return
  }
  if (!expected.isDirectory()) throw errorFactory('不支持操作特殊文件')
  if (process.platform === 'win32') {
    try {
      await fs.lstat(destination)
      throw conflictFactory()
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await check()
    await assertSameEntry(source, expected, errorFactory)
    try {
      await rename(source, destination)
    } catch (error) {
      if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') throw conflictFactory()
      throw error
    }
    return
  }
  try {
    await fs.mkdir(destination)
  } catch (error) {
    if (error.code === 'EEXIST') throw conflictFactory()
    throw error
  }
  const reservation = await fs.lstat(destination)
  try {
    await check()
    await assertSameEntry(source, expected, errorFactory)
    await assertSameEntry(destination, reservation, errorFactory)
    await rename(source, destination)
  } catch (error) {
    try {
      await check()
      await assertSameEntry(destination, reservation, errorFactory)
      await fs.rmdir(destination)
    } catch {}
    if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') throw conflictFactory()
    throw error
  }
}

async function copyFileNoReplace(source, destination, expected, { check, errorFactory, conflictFactory }) {
  const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)
  const sourceHandle = await fs.open(source, readFlags)
  let destinationHandle
  let destinationStat
  try {
    const before = await sourceHandle.stat({ bigint: true })
    if (!before.isFile() || before.dev !== BigInt(expected.dev) || before.ino !== BigInt(expected.ino) ||
      before.size !== BigInt(expected.size)) throw errorFactory('文件在复制前发生变化')
    await check()
    try {
      destinationHandle = await fs.open(destination, 'wx', expected.mode & 0o777)
    } catch (error) {
      if (error.code === 'EEXIST') throw conflictFactory()
      throw error
    }
    destinationStat = await destinationHandle.stat()
    const buffer = Buffer.allocUnsafe(256 * 1024)
    let position = 0
    while (position < expected.size) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, Math.min(buffer.length, expected.size - position), position)
      if (!bytesRead) throw errorFactory('文件在复制期间发生变化')
      let written = 0
      while (written < bytesRead) {
        const result = await destinationHandle.write(buffer, written, bytesRead - written, position + written)
        if (!result.bytesWritten) throw errorFactory('文件复制未完成')
        written += result.bytesWritten
      }
      position += bytesRead
    }
    await destinationHandle.chmod(expected.mode & 0o777)
    await destinationHandle.utimes(expected.atime, expected.mtime)
    const after = await sourceHandle.stat({ bigint: true })
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw errorFactory('文件在复制期间发生变化')
    }
    await check()
    await assertSameEntry(source, expected, errorFactory)
    await assertSameEntry(destination, destinationStat, errorFactory)
    await fs.unlink(source)
  } catch (error) {
    if (destinationStat) {
      try {
        await check()
        await assertSameEntry(destination, destinationStat, errorFactory)
        await fs.unlink(destination)
      } catch {}
    }
    throw error
  } finally {
    await destinationHandle?.close().catch(() => {})
    await sourceHandle.close().catch(() => {})
  }
}
