import assert from 'node:assert/strict'
import test from 'node:test'
import { isPermissionDenied, requestErrorMessage } from '../src/requestErrorMessage.js'

test('API permission failures display a clear workspace access message', () => {
  const error = {
    message: 'Request failed with status code 403',
    response: {
      status: 403,
      data: { code: 'PERMISSION_DENIED', error: '无权限访问或修改该路径', systemCode: 'EACCES' },
    },
  }
  assert.equal(isPermissionDenied(error), true)
  assert.equal(requestErrorMessage(error), '无权限访问或修改该路径')
})

test('raw POSIX read-only errors are recognized even before API normalization', () => {
  for (const code of ['EACCES', 'EPERM', 'EROFS']) {
    assert.equal(requestErrorMessage({ response: { data: { code } } }), '无权限访问或修改该路径')
  }
})

test('other request failures retain the supplied fallback', () => {
  assert.equal(requestErrorMessage({ response: { status: 500 } }, '保存失败'), '保存失败')
  assert.equal(requestErrorMessage({ message: 'offline' }, '保存失败'), 'offline')
})
