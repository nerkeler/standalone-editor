// @ts-check
import fs from 'fs/promises'
import path from 'path'
import { createPasswordRecord } from './authService.js'

/**
 * Hidden terminal input using raw mode. Entered characters are masked with `*`.
 * Backspace and Ctrl-U work; Ctrl-C / Ctrl-D abort.
 * @param {string} query
 * @param {{ write?: (text: string) => void }} [options]
 * @returns {Promise<string>}
 */
export async function promptHidden(query, { write = process.stderr.write.bind(process.stderr) } = {}) {
  write(`${query}（输入内容不回显）：\n`)
  if (!process.stdin.isTTY) {
    throw new Error('需要交互终端输入密码；非交互环境请使用 EDITOR_PASSWORD 环境变量。')
  }
  process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf-8')
  let value = ''
  try {
    await new Promise((resolve, reject) => {
      /** @param {string} chunk */
      function onData(chunk) {
        if (chunk === '\r' || chunk === '\n') {
          process.stdin.off('data', onData)
          write('\n')
          resolve(value)
          return
        }
        if (chunk === '\x04' || chunk === '\x03') {
          process.stdin.off('data', onData)
          write('\n')
          reject(new Error('输入已取消'))
          return
        }
        if (chunk === '\x7f' || chunk === '\b') {
          value = value.slice(0, -1)
          return
        }
        if (chunk === '\x15') {
          value = ''
          return
        }
        if (chunk.codePointAt(0) < 0x20) return
        value += chunk
        write('*')
      }
      process.stdin.on('data', onData)
    })
  } finally {
    process.stdin.setRawMode(false)
    process.stdin.pause()
  }
  return value
}

/**
 * Read once, then ask again to confirm silently.
 * @param {{ write?: (text: string) => void }} [options]
 */
export async function promptAndPasswordConfirmation(options = {}) {
  const first = await promptHidden('设置编辑器访问密码', options)
  if (first.length < 6) throw new Error('密码太短：至少 6 个字符。')
  const second = await promptHidden('再次输入以确认', options)
  if (first !== second) throw new Error('两次输入不一致，未做任何更改。')
  return first
}

/**
 * Write or clear the auth file. Uses a temp+rename so a crash cannot leave a
 * half-written auth record.
 * @param {string} authFile
 * @param {string} password
 */
export async function savePassword(authFile, password) {
  const record = await createPasswordRecord(password)
  await fs.mkdir(path.dirname(path.resolve(authFile)), { recursive: true })
  const temporary = `${authFile}.set.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(record, null, 2), { mode: 0o600 })
    await fs.chmod(temporary, 0o600)
    await fs.rename(temporary, authFile)
  } finally {
    await fs.unlink(temporary).catch(() => {})
  }
}

/** @param {string} authFile */
export async function clearPassword(authFile) {
  await fs.unlink(authFile).catch(error => {
    if (error?.code !== 'ENOENT') throw error
  })
}
