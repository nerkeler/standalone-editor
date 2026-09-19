import test from 'node:test'
import assert from 'node:assert/strict'
import {
  breadcrumbFor,
  configuredRootValues,
  defaultRootCandidates,
  isDirectoryNavigable,
  isDirectorySelectable,
  isWithinPath,
  parentPath,
} from '../src/directoryPicker.js'

test('POSIX allow-list boundaries distinguish roots from similarly named siblings', () => {
  assert.equal(isWithinPath('/tmp/notes', '/tmp/notes', 'linux'), true)
  assert.equal(isWithinPath('/tmp/notes', '/tmp/notes/nested', 'linux'), true)
  assert.equal(isWithinPath('/tmp/notes', '/tmp/notes-old', 'linux'), false)
  assert.equal(isWithinPath('/', '/tmp/notes', 'linux'), true)
})

test('Windows drive and UNC paths work when exercised on macOS', () => {
  assert.equal(isWithinPath('C:\\', 'C:\\Users\\alice', 'win32'), true)
  assert.equal(isWithinPath('C:\\', 'D:\\Users\\alice', 'win32'), false)
  assert.equal(isWithinPath('\\\\server\\share', '\\\\server\\share\\notes', 'win32'), true)
  assert.equal(isWithinPath('\\\\server\\share', '\\\\server\\share-old', 'win32'), false)
  assert.equal(parentPath('C:\\', 'win32'), null)
  assert.equal(parentPath('C:\\Users\\alice', 'win32'), 'C:\\Users')
  assert.deepEqual(breadcrumbFor('C:\\Users\\alice', 'win32'), [
    { name: 'C:\\', path: 'C:\\' },
    { name: 'Users', path: 'C:\\Users' },
    { name: 'alice', path: 'C:\\Users\\alice' },
  ])
})

test('configured roots use the host delimiter and ancestors are browseable only', () => {
  assert.deepEqual(configuredRootValues('C:\\Notes;D:\\Archive', 'win32'), ['C:\\Notes', 'D:\\Archive'])
  assert.deepEqual(configuredRootValues('/Users/alice:/Volumes/Notes', 'darwin'), ['/Users/alice', '/Volumes/Notes'])
  assert.equal(isDirectoryNavigable('/tmp', ['/tmp/notes'], { platform: 'linux' }), true)
  assert.equal(isDirectorySelectable('/tmp', ['/tmp/notes'], 'linux'), false)
  assert.equal(isDirectorySelectable('/tmp/notes', ['/tmp/notes'], 'linux'), true)
})

test('default candidates expose platform-specific user and mount locations', () => {
  const mac = defaultRootCandidates({ platform: 'darwin', home: '/Users/alice' })
  assert.deepEqual(mac.slice(0, 4), ['/Users/alice', '/Users', '/Volumes', '/tmp'])

  const linux = defaultRootCandidates({ platform: 'linux', home: '/home/alice' })
  assert.deepEqual(linux.slice(0, 4), ['/home/alice', '/mnt', '/media', '/run/media/alice'])

  const windows = defaultRootCandidates({
    platform: 'win32',
    home: 'C:\\Users\\alice',
    env: { SystemDrive: 'C:' },
  })
  assert.deepEqual(windows.slice(0, 3), ['C:\\Users\\alice', 'C:\\Users', 'C:\\'])
  assert.ok(windows.includes('Z:\\'))
})
