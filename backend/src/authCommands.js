// @ts-check
import path from 'path'
import os from 'os'
import { promptAndPasswordConfirmation, savePassword, clearPassword } from './passwordCli.js'

export function defaultAuthFile() {
  return path.join(os.homedir(), '.standalone-editor', 'auth.json')
}

/**
 * Handle `--set-password` / `--clear-password` in the running entry point.
 * The service must not be started simultaneously with this command; a
 * supervisor restart (see docs/release-runtime.md) picks up the new file.
 * @param {'set' | 'clear'} command
 * @param {{ env?: typeof process.env, write?: (text: string) => void }} [options]
 * @returns {Promise<number>} exit code
 */
export async function handleAuthCommand(command, { env = process.env, write } = {}) {
  const authFile = env.EDITOR_AUTH_FILE || defaultAuthFile()
  try {
    if (command === 'clear') {
      await clearPassword(authFile)
      console.log(`已清除访问密码：${authFile}（重启服务后恢复免登录模式）`)
      return 0
    }
    const password = await promptAndPasswordConfirmation({ write })
    await savePassword(authFile, password)
    console.log(`访问密码已更新：${authFile}（重启服务后生效）`)
    return 0
  } catch (error) {
    console.error(`❌ ${/** @type {Error} */ (error)?.message || '密码设置失败'}`)
    return 1
  }
}
