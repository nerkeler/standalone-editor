import assert from 'node:assert/strict'
import test from 'node:test'
import { permissionErrorResponse } from '../src/permissionErrors.js'

test('filesystem permission failures have a stable 403 response', () => {
  for (const code of ['EACCES', 'EPERM', 'EROFS']) {
    assert.deepEqual(permissionErrorResponse({ code }), {
      status: 403,
      body: {
        error: '无权限访问或修改该路径',
        code: 'PERMISSION_DENIED',
        systemCode: code,
      },
    })
  }
})

test('permission failures wrapped by workspace config retain their system cause', () => {
  assert.deepEqual(permissionErrorResponse({
    code: 'WORKSPACE_CONFIG_SAVE_FAILED',
    details: { causeCode: 'EACCES' },
  }), {
    status: 403,
    body: {
      error: '无权限访问或修改该路径',
      code: 'PERMISSION_DENIED',
      systemCode: 'EACCES',
    },
  })
})

test('unrelated filesystem errors keep their existing handling', () => {
  assert.equal(permissionErrorResponse({ code: 'ENOENT' }), null)
  assert.equal(permissionErrorResponse({ code: 'INVALID_DIRECTORY' }), null)
})
