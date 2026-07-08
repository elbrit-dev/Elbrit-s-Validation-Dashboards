import 'server-only'

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Retry 5xx / network errors with linear backoff (doctor-tool pattern).
export async function fetchRetry(url: string, opts: RequestInit = {}, tries = 4): Promise<Response> {
  let last: unknown
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, opts)
      if (r.status < 500) return r
      last = new Error(`HTTP ${r.status}`)
    } catch (e) {
      last = e
    }
    if (i < tries - 1) await sleep(600 * (i + 1))
  }
  throw last instanceof Error ? last : new Error('request failed')
}

// Run fn over items with at most `limit` in flight.
export async function mapLimit<T>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<void>): Promise<void> {
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = i++
      if (idx >= items.length) break
      await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
}
