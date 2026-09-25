import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createUploadedImageReference,
  isExternalImageReference,
  resolveMarkdownImageReference,
} from '../src/markdownImagePaths.js'

const identity = { workspaceId: 'workspace-123', workspaceVersion: 7 }

test('relative images resolve from nested documents and canonicalize to portable Markdown paths', () => {
  const image = resolveMarkdownImageReference('../images/cover.png', 'docs/guide/readme.md', identity)

  assert.deepEqual(image, {
    workspacePath: 'docs/images/cover.png',
    markdownSrc: '../images/cover.png',
    url: '/api/workspace/media/docs/images/cover.png?workspaceId=workspace-123&workspaceVersion=7',
  })
})

test('percent-encoded Unicode and spaces are decoded for lookup and encoded in the media URL', () => {
  const image = resolveMarkdownImageReference('../../图片/封 面.png', 'docs/topic/readme.md', identity)
  const encoded = resolveMarkdownImageReference('../../%E5%9B%BE%E7%89%87/%E5%B0%81%20%E9%9D%A2.png', 'docs/topic/readme.md', identity)

  assert.equal(image.workspacePath, '图片/封 面.png')
  assert.equal(encoded.workspacePath, image.workspacePath)
  assert.equal(image.markdownSrc, '../../%E5%9B%BE%E7%89%87/%E5%B0%81%20%E9%9D%A2.png')
  assert.equal(image.url, '/api/workspace/media/%E5%9B%BE%E7%89%87/%E5%B0%81%20%E9%9D%A2.png?workspaceId=workspace-123&workspaceVersion=7')
})

test('root asset uploads become relative to the active nested document', () => {
  const image = createUploadedImageReference('assets/diagram 1.png', 'docs/reference.md', identity)

  assert.equal(image.workspacePath, 'assets/diagram 1.png')
  assert.equal(image.markdownSrc, '../assets/diagram%201.png')
  assert.equal(image.url, '/api/workspace/media/assets/diagram%201.png?workspaceId=workspace-123&workspaceVersion=7')
})

test('literal percent characters are encoded once for Markdown and media URLs', () => {
  const source = resolveMarkdownImageReference('100%25.png', 'docs/readme.md', identity)
  const upload = createUploadedImageReference('assets/100%.png', 'docs/readme.md', identity)

  assert.equal(source.workspacePath, 'docs/100%.png')
  assert.equal(source.markdownSrc, '100%25.png')
  assert.equal(source.url, '/api/workspace/media/docs/100%25.png?workspaceId=workspace-123&workspaceVersion=7')
  assert.equal(upload.markdownSrc, '../assets/100%25.png')
  assert.equal(upload.url, '/api/workspace/media/assets/100%25.png?workspaceId=workspace-123&workspaceVersion=7')
})

test('legacy asset URLs normalize to relative paths and discard stale workspace identity', () => {
  const image = resolveMarkdownImageReference(
    '/api/workspace/assets/cover%20art.png?workspaceId=old&workspaceVersion=2',
    'docs/readme.md',
    identity,
  )

  assert.equal(image.workspacePath, 'assets/cover art.png')
  assert.equal(image.markdownSrc, '../assets/cover%20art.png')
  assert.equal(image.url, '/api/workspace/media/assets/cover%20art.png?workspaceId=workspace-123&workspaceVersion=7')
})

test('relative query and fragment data survives mapping while workspace identity stays current', () => {
  const image = resolveMarkdownImageReference('../cover.png?v=2#preview', 'docs/note.md', identity)

  assert.equal(image.workspacePath, 'cover.png')
  assert.equal(image.markdownSrc, '../cover.png?v=2#preview')
  assert.equal(image.url, '/api/workspace/media/cover.png?v=2&workspaceId=workspace-123&workspaceVersion=7#preview')
})

test('escaping, malformed encoding, absolute paths and external URLs are not mapped into the workspace', () => {
  assert.equal(resolveMarkdownImageReference('../../../private.png', 'docs/readme.md', identity), null)
  assert.equal(resolveMarkdownImageReference('bad%2Fsegment.png', 'docs/readme.md', identity), null)
  assert.equal(resolveMarkdownImageReference('/private.png', 'docs/readme.md', identity), null)
  assert.equal(resolveMarkdownImageReference('bad%.png', 'docs/readme.md', identity), null)
  assert.equal(isExternalImageReference('https://example.test/image.png'), true)
  assert.equal(isExternalImageReference('data:image/png;base64,AAAA'), true)
  assert.equal(resolveMarkdownImageReference('https://example.test/image.png', 'docs/readme.md', identity), null)
  assert.equal(resolveMarkdownImageReference('data:image/png;base64,AAAA', 'docs/readme.md', identity), null)
})
