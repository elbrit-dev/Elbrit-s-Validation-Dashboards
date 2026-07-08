// Diffs all sheet rows against the ERP index off the main thread.
import { triageRows, type TriageInputRow } from '../lib/shared/triage'
import type { ErpSummary } from '../lib/shared/types'

interface TriageRequest {
  rows: TriageInputRow[]
  erpIndex: [string, ErpSummary][]
}

const post = (msg: unknown) => (self as unknown as { postMessage: (m: unknown) => void }).postMessage(msg)

self.onmessage = (e: MessageEvent<TriageRequest>) => {
  try {
    const index = new Map(e.data.erpIndex)
    const out = triageRows(e.data.rows, index)
    post({ type: 'done', results: out })
  } catch (err) {
    post({ type: 'error', error: err instanceof Error ? err.message : String(err) })
  }
}
