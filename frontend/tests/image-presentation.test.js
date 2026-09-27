import test from 'node:test'
import assert from 'node:assert/strict'
import { parseImagePresentationComment, formatImagePresentationComment } from '../src/pages/imagePresentation.js'

test('portable image presentation comment parses and formats only bounded metadata', () => {
  assert.deepEqual(parseImagePresentationComment(' se-image:width=65;align=center '), { width: 65, align: 'center' })
  assert.equal(formatImagePresentationComment(65, 'center'), '<!-- se-image:width=65;align=center -->')
  assert.equal(formatImagePresentationComment(100, 'left'), '')
  for (const value of ['se-image:width=999;align=center', 'se-image:width=50;align=right', 'zoom:175']) {
    assert.equal(parseImagePresentationComment(value), null)
  }
})
