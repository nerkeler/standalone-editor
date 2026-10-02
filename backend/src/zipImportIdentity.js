const FILE_TYPE_MASK = 0o170000n

export function sameFileSnapshot(left, right) {
  return left.isFile() && !left.isSymbolicLink() && right.isFile() && !right.isSymbolicLink() &&
    left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs &&
    (left.mode & FILE_TYPE_MASK) === (right.mode & FILE_TYPE_MASK)
}

export function fileFingerprint(stat, sha256) {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('ZIP rollback target is not a regular file')
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    modeType: stat.mode & FILE_TYPE_MASK,
    sha256,
  })
}

export function matchesFileFingerprint(stat, expected, sha256) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.dev === expected.dev && stat.ino === expected.ino &&
    stat.size === expected.size && stat.mtimeNs === expected.mtimeNs && stat.ctimeNs === expected.ctimeNs &&
    (stat.mode & FILE_TYPE_MASK) === expected.modeType && sha256 === expected.sha256
}

export function directoryIdentity(stat) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('ZIP rollback parent is not a directory')
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    birthtimeNs: stat.birthtimeNs,
    modeType: stat.mode & FILE_TYPE_MASK,
  })
}

export function directoryFingerprint(stat) {
  const identity = directoryIdentity(stat)
  return Object.freeze({
    ...identity,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  })
}

export function matchesDirectoryIdentity(stat, expected) {
  return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === expected.dev && stat.ino === expected.ino &&
    stat.birthtimeNs === expected.birthtimeNs && (stat.mode & FILE_TYPE_MASK) === expected.modeType
}

export function matchesDirectoryFingerprint(stat, expected) {
  return matchesDirectoryIdentity(stat, expected) && stat.size === expected.size &&
    stat.mtimeNs === expected.mtimeNs && stat.ctimeNs === expected.ctimeNs
}
