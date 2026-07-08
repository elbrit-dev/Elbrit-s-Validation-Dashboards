// Generic client-driven batch loop (doctor-tool pattern, generalized).
// The browser owns the offset: it slices items, POSTs one small slice at a
// time, retries transient failures with backoff, honors the server's `pending`
// re-slice signal, and reports progress. A failed batch records errors and
// moves on — it never kills the run. Pause/abort via the returned controls.
import type { BatchResponse, RowResult } from '../shared/types'

export interface RunOptions<T> {
  items: T[]
  batchSize: number
  endpoint: string
  buildBody: (slice: T[]) => unknown
  keyOf: (item: T) => string
  onResult: (results: RowResult[]) => void | Promise<void>
  onProgress?: (done: number, total: number) => void
  signal?: { paused: boolean; aborted: boolean }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const RETRIES = 3

export async function runInBatches<T>(opts: RunOptions<T>): Promise<{ completed: boolean }> {
  const { items, batchSize, endpoint, buildBody, keyOf, onResult, onProgress, signal } = opts
  const byKey = new Map(items.map((i) => [keyOf(i), i]))
  let queue = items.slice()
  let done = 0
  const total = items.length

  while (queue.length > 0) {
    if (signal?.aborted) return { completed: false }
    while (signal?.paused) {
      if (signal.aborted) return { completed: false }
      await sleep(300)
    }

    const slice = queue.slice(0, batchSize)
    queue = queue.slice(batchSize)

    let body: BatchResponse | null = null
    let lastErr = ''
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(buildBody(slice)),
        })
        const json = await res.json().catch(() => ({}))
        if (res.ok) {
          body = json as BatchResponse
          break
        }
        lastErr = json.detail || json.error || `HTTP ${res.status}`
        // 4xx won't get better by retrying
        if (res.status < 500 && res.status !== 429) break
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e)
      }
      if (attempt < RETRIES - 1) await sleep(1200 * (attempt + 1))
    }

    if (!body) {
      // Whole batch failed after retries — record per-row errors, keep going.
      await onResult(slice.map((i) => ({ key: keyOf(i), ok: false, error: lastErr || 'request failed' })))
      done += slice.length
      onProgress?.(done, total)
      continue
    }

    await onResult(body.results || [])
    done += (body.results || []).length

    // Rows the server didn't reach before its soft deadline go back in front.
    if (body.pending?.length) {
      const requeue = body.pending.map((k) => byKey.get(k)).filter((x): x is T => x !== undefined)
      queue = [...requeue, ...queue]
    }
    onProgress?.(done, total)
  }
  return { completed: true }
}
