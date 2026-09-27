import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { startChrome } from './helpers/chrome-startup.js'

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return

  const waitForClose = async timeoutMs => {
    let timeoutId
    const closed = await Promise.race([
      once(child, 'close').then(() => true),
      new Promise(resolve => { timeoutId = setTimeout(() => resolve(false), timeoutMs) }),
    ])
    clearTimeout(timeoutId)
    return closed
  }

  child.kill('SIGTERM')
  if (await waitForClose(1_000)) return
  child.kill('SIGKILL')
  await waitForClose(1_000)
}

test('Chrome startup fails promptly with bounded stderr when CHROME_PATH exits early', { skip: process.platform === 'win32' }, async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'standalone-editor-chrome-startup-'))
  const previousChromePath = process.env.CHROME_PATH
  const chromeStub = path.join(tempRoot, 'chrome-stub')
  t.after(async () => {
    if (previousChromePath === undefined) delete process.env.CHROME_PATH
    else process.env.CHROME_PATH = previousChromePath
    await rm(tempRoot, { recursive: true, force: true })
  })

  await writeFile(chromeStub, [
    '#!/bin/sh',
    'invocations="$(dirname "$0")/invocations"',
    'count=0',
    '[ ! -f "$invocations" ] || count=$(cat "$invocations")',
    'count=$((count + 1))',
    'printf "%s" "$count" > "$invocations"',
    'i=0',
    'while [ "$i" -lt 300 ]; do',
    '  printf "diagnostic filler 0123456789 abcdefghijklmnopqrstuvwxyz 0123456789 abcdefghijklmnopqrstuvwxyz\\n" >&2',
    '  i=$((i + 1))',
    'done',
    'printf "intentional Chrome startup failure\\n" >&2',
    'exit 7',
    '',
  ].join('\n'))
  await chmod(chromeStub, 0o755)
  process.env.CHROME_PATH = chromeStub

  const startedAt = Date.now()
  await assert.rejects(startChrome({
    profileDir: path.join(tempRoot, 'profile'),
    timeoutMs: 5_000,
  }), error => {
    assert.match(error.message, /Chrome failed to start after 2 attempts/)
    assert.match(error.message, /Chrome exited before DevTools became ready/)
    assert.match(error.message, /exit code 7/)
    assert.match(error.message, /intentional Chrome startup failure/)
    assert.match(error.message, /Attempt 1 failed with profile .*\/profile:/)
    assert.match(error.message, /Attempt 2 failed with profile .*\/profile-retry-/)
    assert.equal((error.message.match(/Chrome stderr \(last 8000 characters\)/g) || []).length, 2)
    assert.ok(error.message.length < 18_000, 'both reported stderr tails should remain bounded')
    assert.ok(Date.now() - startedAt < 4_000, 'an early exit should fail before the startup timeout')
    return true
  })
  assert.equal(await readFile(path.join(tempRoot, 'invocations'), 'utf8'), '2')
})

test('Chrome startup retries once with a fresh profile after a transient CHROME_PATH failure', { skip: process.platform === 'win32' }, async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'standalone-editor-chrome-retry-'))
  const previousChromePath = process.env.CHROME_PATH
  const chromeStub = path.join(tempRoot, 'chrome-stub.js')
  let started
  t.after(async () => {
    try {
      await stopChild(started?.child)
    } finally {
      if (previousChromePath === undefined) delete process.env.CHROME_PATH
      else process.env.CHROME_PATH = previousChromePath
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  await writeFile(chromeStub, `#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const invocationFile = path.join(__dirname, 'invocations')
const count = Number(fs.existsSync(invocationFile) ? fs.readFileSync(invocationFile, 'utf8') : '0') + 1
fs.writeFileSync(invocationFile, String(count))
if (count === 1) {
  process.stderr.write('transient Chrome startup failure\\n')
  process.exit(9)
}
const profileArg = process.argv.find(argument => argument.startsWith('--user-data-dir='))
if (!profileArg) {
  process.stderr.write('Chrome profile argument is missing\\n')
  process.exit(2)
}
const profileDir = profileArg.slice('--user-data-dir='.length)
fs.mkdirSync(profileDir, { recursive: true })
const server = http.createServer((request, response) => {
  if (request.url !== '/json/version') {
    response.writeHead(404).end()
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1/test-browser' }))
})
process.on('SIGTERM', () => server.close(() => process.exit(0)))
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(path.join(profileDir, 'DevToolsActivePort'), String(server.address().port) + '\\n/devtools/browser/test\\n')
})
`)
  await chmod(chromeStub, 0o755)
  process.env.CHROME_PATH = chromeStub

  started = await startChrome({ profileDir: path.join(tempRoot, 'profile'), timeoutMs: 5_000 })
  const invocationCount = await readFile(path.join(tempRoot, 'invocations'), 'utf8')
  assert.equal(invocationCount, '2')
  assert.equal(started.attempts.length, 2)
  assert.match(started.attempts[0].error, /exit code 9/)
  assert.match(started.attempts[0].error, /transient Chrome startup failure/)
  assert.equal(started.attempts[1].ready, true)
  assert.notEqual(started.attempts[0].profileDir, started.profileDir)
  assert.equal(path.dirname(started.profileDir), tempRoot)
  assert.match(path.basename(started.profileDir), /^profile-retry-/)
  assert.ok(started.port > 0)
})
