export function createSearchCoordinator({ delayMs = 250, search, onResults, onLoading }) {
  let timer = null
  let requestSequence = 0
  let disposed = false

  const isCurrent = sequence => !disposed && sequence === requestSequence

  function query(input) {
    if (disposed) return
    const sequence = ++requestSequence
    if (timer !== null) clearTimeout(timer)
    timer = null

    const value = typeof input === 'string' ? input.trim() : ''
    onResults([])
    if (!value) {
      onLoading(false)
      return
    }

    onLoading(true)
    timer = setTimeout(async () => {
      timer = null
      try {
        const results = await search(value)
        if (isCurrent(sequence)) onResults(Array.isArray(results) ? results : [])
      } catch {
        if (isCurrent(sequence)) onResults([])
      } finally {
        if (isCurrent(sequence)) onLoading(false)
      }
    }, delayMs)
  }

  function dispose() {
    if (disposed) return
    disposed = true
    requestSequence += 1
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  return { query, dispose }
}
