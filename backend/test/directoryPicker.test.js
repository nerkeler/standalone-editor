import test from 'node:test'
import assert from 'node:assert/strict'
import {
  breadcrumbFor,
  configuredRootValues,
  defaultRootCandidates,
  isDirectoryNavigable,
  isDirectoryPickerSelectionAllowed,
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
  assert.deepEqual(mac, ['/'])

  const linux = defaultRootCandidates({ platform: 'linux', home: '/home/alice' })
  assert.deepEqual(linux, ['/'])

  const windows = defaultRootCandidates({
    platform: 'win32',
    home: 'C:\\Users\\alice',
    env: { SystemDrive: 'C:' },
  })
  assert.deepEqual(windows.slice(0, 3), ['C:\\Users\\alice', 'C:\\Users', 'C:\\'])
  assert.ok(windows.includes('Z:\\'))
})

test('default POSIX root allows any descendant and explicit roots remain the only path policy', () => {
  const roots = defaultRootCandidates({ platform: 'linux', home: '/home/alice' })
  assert.deepEqual(roots, ['/'])
  assert.equal(isDirectoryNavigable('/', roots, { platform: 'linux' }), true)
  assert.equal(isDirectoryPickerSelectionAllowed('/', roots, {
    platform: 'linux',
  }), true)
  assert.equal(isDirectoryPickerSelectionAllowed('/srv/notes', roots, {
    platform: 'linux',
  }), true)
  assert.equal(isDirectoryPickerSelectionAllowed('/data/notes', roots, {
    platform: 'linux',
  }), true)
  assert.deepEqual(defaultRootCandidates({ platform: 'darwin', home: '/Users/alice' }), ['/'])

  const restricted = ['/srv/notes']
  assert.equal(isDirectoryPickerSelectionAllowed('/srv/notes', restricted, { platform: 'linux' }), true)
  assert.equal(isDirectoryPickerSelectionAllowed('/data/notes', restricted, { platform: 'linux' }), false)
})

test('explicit Linux roots stay narrow and preserve explicitly allowed filesystem roots', () => {
  const roots = ['/srv/notes']
  const configured = { platform: 'linux', hasConfiguredRoots: true }
  assert.equal(isDirectoryPickerSelectionAllowed('/srv/notes', roots, configured), true)
  assert.equal(isDirectoryPickerSelectionAllowed('/srv/notes/drafts', roots, configured), true)
  assert.equal(isDirectoryPickerSelectionAllowed('/data/notes', roots, configured), false)
  assert.equal(isDirectoryNavigable('/', roots, { platform: 'linux' }), true)
  assert.equal(isDirectoryPickerSelectionAllowed('/', ['/'], configured), true)
})
