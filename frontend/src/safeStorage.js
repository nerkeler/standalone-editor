function errorCode(error) {
  if (error?.storageCode) return error.storageCode
  if (error?.name === 'QuotaExceededError' || error?.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || error?.code === 22 || error?.code === 1014) return 'quota'
  if (error?.name === 'SecurityError') return 'security'
  return 'error'
}

function storageAccess(storageName) {
  try {
    const storage = globalThis[storageName]
    if (!storage) {
      const error = new Error(`${storageName} is unavailable`)
      error.storageCode = 'unavailable'
      return { ok: false, error, code: 'unavailable' }
    }
    return { ok: true, storage }
  } catch (error) {
    return { ok: false, error, code: errorCode(error) }
  }
}

export function classifyStorageError(error) {
  return errorCode(error)
}

export function readStorage(key, storageName = 'localStorage') {
  const access = storageAccess(storageName)
  if (!access.ok) return { ok: false, value: null, error: access.error, code: access.code }
  try {
    return { ok: true, value: access.storage.getItem(key) }
  } catch (error) {
    return { ok: false, value: null, error, code: errorCode(error) }
  }
}

export function writeStorage(key, value, storageName = 'localStorage') {
  const access = storageAccess(storageName)
  if (!access.ok) return { ok: false, error: access.error, code: access.code }
  try {
    access.storage.setItem(key, value)
    return { ok: true }
  } catch (error) {
    return { ok: false, error, code: errorCode(error) }
  }
}

export function removeStorage(key, storageName = 'localStorage') {
  const access = storageAccess(storageName)
  if (!access.ok) return { ok: false, error: access.error, code: access.code }
  try {
    access.storage.removeItem(key)
    return { ok: true }
  } catch (error) {
    return { ok: false, error, code: errorCode(error) }
  }
}

export function readJsonStorage(key, fallback = null, storageName = 'localStorage') {
  const result = readStorage(key, storageName)
  if (!result.ok) return { ...result, value: fallback }
  if (result.value == null || result.value === '') return { ok: true, value: fallback }
  try {
    return { ok: true, value: JSON.parse(result.value) }
  } catch (error) {
    return { ok: false, value: fallback, error, code: 'invalid-json' }
  }
}

export function listStorageKeys(prefix = '', storageName = 'localStorage') {
  const access = storageAccess(storageName)
  if (!access.ok) return { ok: false, keys: [], error: access.error, code: access.code }
  try {
    const keys = []
    for (let index = 0; index < access.storage.length; index += 1) {
      const key = access.storage.key(index)
      if (typeof key === 'string' && key.startsWith(prefix)) keys.push(key)
    }
    return { ok: true, keys }
  } catch (error) {
    return { ok: false, keys: [], error, code: errorCode(error) }
  }
}
