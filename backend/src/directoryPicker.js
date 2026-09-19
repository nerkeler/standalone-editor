import os from 'os'
import path from 'path'

// Keep path decisions injectable so the macOS test runner can exercise the
// Windows and POSIX rules without pretending that process.platform changed.
export function pathModuleFor(platform = process.platform) {
  return platform === 'win32' ? path.win32 : path.posix
}

export function configuredRootValues(value, platform = process.platform) {
  if (typeof value !== 'string' || !value.trim()) return []
  const delimiter = platform === 'win32' ? ';' : ':'
  return value.split(delimiter).map(item => item.trim()).filter(Boolean)
}

export function defaultRootCandidates({
  platform = process.platform,
  home = os.homedir(),
  env = process.env,
} = {}) {
  const pathModule = pathModuleFor(platform)
  if (platform === 'win32') {
    const homeRoot = pathModule.parse(home).root || 'C:\\'
    const systemDrive = env.SystemDrive
      ? (env.SystemDrive.endsWith('\\') ? env.SystemDrive : `${env.SystemDrive}\\`)
      : homeRoot
    const values = [home, pathModule.join(systemDrive, 'Users'), systemDrive]
    // Drive roots are filtered by the caller with fs.realpath/stat. Keeping
    // all letters here means removable/network mounted drives are discoverable
    // when present, while absent drives never become fake picker entries.
    for (let code = 65; code <= 90; code += 1) values.push(`${String.fromCharCode(code)}:\\`)
    return [...new Set(values)]
  }
  if (platform === 'darwin') {
    return [...new Set([home, '/Users', '/Volumes', '/tmp'])]
  }
  return [...new Set([
    home,
    '/mnt',
    '/media',
    pathModule.join('/run/media', pathModule.basename(home)),
    '/tmp',
  ].filter(Boolean))]
}

export function normalizePickerPath(value, platform = process.platform) {
  const pathModule = pathModuleFor(platform)
  return pathModule.normalize(pathModule.resolve(value))
}

export function isWithinPath(root, target, platform = process.platform) {
  const pathModule = pathModuleFor(platform)
  const relative = pathModule.relative(pathModule.resolve(root), pathModule.resolve(target))
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${pathModule.sep}`) &&
    !pathModule.isAbsolute(relative)
  )
}

export function isDirectoryNavigable(target, roots, {
  platform = process.platform,
  allowFilesystemRoot = true,
} = {}) {
  const pathModule = pathModuleFor(platform)
  const normalizedTarget = pathModule.resolve(target)
  const normalizedRoots = roots.map(root => pathModule.resolve(root))
  if (normalizedRoots.some(root => isWithinPath(root, normalizedTarget, platform))) return true
  if (allowFilesystemRoot && normalizedTarget === pathModule.parse(normalizedTarget).root) return true
  // A filesystem root or mount parent can be used to reach a configured root,
  // but remains non-selectable until the user reaches that root.
  return normalizedRoots.some(root => isWithinPath(normalizedTarget, root, platform))
}

export function isDirectorySelectable(target, roots, platform = process.platform) {
  return roots.some(root => isWithinPath(root, target, platform))
}

export function parentPath(value, platform = process.platform) {
  const pathModule = pathModuleFor(platform)
  const normalized = pathModule.resolve(value)
  const root = pathModule.parse(normalized).root
  const parent = pathModule.dirname(normalized)
  return normalized === root ? null : parent
}

export function displayName(value, platform = process.platform) {
  const pathModule = pathModuleFor(platform)
  const normalized = pathModule.resolve(value)
  const root = pathModule.parse(normalized).root
  return normalized === root ? root : pathModule.basename(normalized)
}

export function breadcrumbFor(value, platform = process.platform) {
  const pathModule = pathModuleFor(platform)
  const normalized = pathModule.resolve(value)
  const root = pathModule.parse(normalized).root
  const result = [{ name: displayName(root, platform), path: root }]
  const relative = pathModule.relative(root, normalized)
  let current = root
  for (const part of relative ? relative.split(pathModule.sep) : []) {
    current = pathModule.join(current, part)
    result.push({ name: part, path: current })
  }
  return result
}

export function rootEntry(root, platform = process.platform) {
  const pathModule = pathModuleFor(platform)
  const normalized = pathModule.resolve(root)
  return {
    name: displayName(normalized, platform),
    path: normalized,
    type: 'dir',
    parent: parentPath(normalized, platform),
    canNavigate: true,
    canSelect: true,
  }
}
