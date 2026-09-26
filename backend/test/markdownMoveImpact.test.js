import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { extractMarkdownReferences } from '../src/markdownMoveImpact.js'
import { getMoveReferenceImpacts } from '../src/fileService.js'

async function temporaryWorkspace(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'standalone-editor-move-impact-'))
  t.after(() => fs.rm(workspace, { recursive: true, force: true }))
  return workspace
}

test('Markdown reference scanner handles inline and reference links while skipping code', () => {
  const markdown = [
    '![photo](<../images/one image.png?size=2#crop>)',
    '[guide][G] and ![small][photo]',
    '[G]: ../docs/guide.md#intro',
    '[photo]: ../images/photo.png "title"',
    '`[inline code](fake.md)`',
    '<!-- [comment](fake-comment.md) -->',
    '```md',
    '![fenced](fake.png)',
    '```',
  ].join('\n')

  assert.deepEqual(extractMarkdownReferences(markdown), [
    { destination: '../images/one image.png?size=2#crop', kind: 'image' },
    { destination: '../docs/guide.md#intro', kind: 'link' },
    { destination: '../images/photo.png', kind: 'image' },
  ])
})

test('move preflight finds incoming and outgoing relative references but ignores external URLs', async t => {
  const workspace = await temporaryWorkspace(t)
  await fs.mkdir(path.join(workspace, 'docs'))
  await fs.mkdir(path.join(workspace, 'archive'))
  await fs.mkdir(path.join(workspace, 'docs', 'local-images'))
  await fs.mkdir(path.join(workspace, 'assets'))
  await fs.writeFile(path.join(workspace, 'docs', 'guide.md'), [
    '![local](local-images/inside.png)',
    '[remote](https://example.com/guide)',
    '`[example](missing.md)`',
  ].join('\n'))
  await fs.writeFile(path.join(workspace, 'docs', 'local-images', 'inside.png'), 'image')
  await fs.writeFile(path.join(workspace, 'assets', 'shared image.png'), 'image')
  await fs.writeFile(path.join(workspace, 'index.md'), [
    '![shared](assets/shared%20image.png?width=300#preview)',
    '[guide](docs/guide.md#start)',
    '[remote](https://example.com/docs/guide.md)',
    '```md',
    '[code](docs/guide.md)',
    '```',
  ].join('\n'))

  const result = await getMoveReferenceImpacts(workspace, 'docs/guide.md', 'archive/guide.md')
  assert.deepEqual(result.unscannedMarkdownFiles, [])
  assert.deepEqual(result.impacts.map(item => ({
    documentPath: item.documentPath,
    kind: item.kind,
    reference: item.reference,
    targetPath: item.targetPath,
    expectedTargetPath: item.expectedTargetPath,
  })), [
    {
      documentPath: 'docs/guide.md',
      kind: 'image',
      reference: 'local-images/inside.png',
      targetPath: 'docs/local-images/inside.png',
      expectedTargetPath: 'docs/local-images/inside.png',
    },
    {
      documentPath: 'index.md',
      kind: 'link',
      reference: 'docs/guide.md#start',
      targetPath: 'docs/guide.md',
      expectedTargetPath: 'archive/guide.md',
    },
  ])
})

test('directory preflight preserves references whose document and target move together, but reports outside inbound links', async t => {
  const workspace = await temporaryWorkspace(t)
  await fs.mkdir(path.join(workspace, 'folder', 'images'), { recursive: true })
  await fs.mkdir(path.join(workspace, 'archive'))
  await fs.writeFile(path.join(workspace, 'folder', 'guide.md'), [
    '![diagram](images/diagram.png?size=large#v1)',
    '[sibling](sibling.md#section)',
    '[website](https://example.com/reference)',
  ].join('\n'))
  await fs.writeFile(path.join(workspace, 'folder', 'sibling.md'), '# Sibling')
  await fs.writeFile(path.join(workspace, 'folder', 'images', 'diagram.png'), 'image')
  await fs.writeFile(path.join(workspace, 'outside.md'), '[guide](folder/guide.md?view=full#intro)')

  const result = await getMoveReferenceImpacts(workspace, 'folder', 'archive/folder')
  assert.deepEqual(result.unscannedMarkdownFiles, [])
  assert.deepEqual(result.impacts.map(item => ({
    documentPath: item.documentPath,
    documentAfterPath: item.documentAfterPath,
    kind: item.kind,
    reference: item.reference,
    targetPath: item.targetPath,
    expectedTargetPath: item.expectedTargetPath,
  })), [{
    documentPath: 'outside.md',
    documentAfterPath: 'outside.md',
    kind: 'link',
    reference: 'folder/guide.md?view=full#intro',
    targetPath: 'folder/guide.md',
    expectedTargetPath: 'archive/folder/guide.md',
  }])
})

test('same-directory rename with only external references has no preflight warning', async t => {
  const workspace = await temporaryWorkspace(t)
  await fs.writeFile(path.join(workspace, 'note.md'), '[site](https://example.com/note)')

  assert.deepEqual(await getMoveReferenceImpacts(workspace, 'note.md', 'renamed.md'), {
    impacts: [],
    unscannedMarkdownFiles: [],
  })
})

test('move preflight names Markdown files too large to inspect instead of treating them as clear', async t => {
  const workspace = await temporaryWorkspace(t)
  await fs.mkdir(path.join(workspace, 'archive'))
  await fs.writeFile(path.join(workspace, 'large.md'), Buffer.alloc(10 * 1024 * 1024 + 1, 0x20))
  await fs.writeFile(path.join(workspace, 'note.md'), '[large](large.md)')

  const result = await getMoveReferenceImpacts(workspace, 'large.md', 'archive/large.md')
  assert.deepEqual(result.unscannedMarkdownFiles, ['large.md'])
  assert.deepEqual(result.impacts, [{
    documentPath: 'note.md',
    documentAfterPath: 'note.md',
    kind: 'link',
    reference: 'large.md',
    targetPath: 'large.md',
    expectedTargetPath: 'archive/large.md',
  }])
})
