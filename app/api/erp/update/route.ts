import { NextResponse } from 'next/server'
import { assertConfigured, mergeChildAppend } from '@/lib/server/erpnext'
import { mapLimit } from '@/lib/server/retry'
import { CHILD_TABLE, DOCTYPE } from '@/lib/shared/mapping'
import type { BatchResponse, RowResult } from '@/lib/shared/types'

// POST { rows: [{ key, erpName, items: [...] }] }  (≤ 50/call)
// The parent already exists (same distributor + date). We MERGE the sheet's
// product lines into the doc's existing `items` table — APPENDING new products
// and leaving items from other divisions untouched. Merge key is the item name
// (a product belongs to one division, so it never repeats across sheets); a
// re-run of the same division just overlays its own lines (idempotent).
// Rows are keyed by distinct erpName so no document is written concurrently.
const MAX_ROWS = 50
const CONCURRENCY = 5
const DEADLINE_MS = 8000

interface InRow { key: string; erpName: string; items: unknown[] }

export async function POST(req: Request) {
  try {
    assertConfigured()
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 })
  }
  const body = await req.json().catch(() => ({}))
  const rows: InRow[] = Array.isArray(body?.rows) ? body.rows : []
  if (rows.length === 0) return NextResponse.json({ error: 'rows[] is required' }, { status: 400 })
  if (rows.length > MAX_ROWS) return NextResponse.json({ error: `Max ${MAX_ROWS} rows per call` }, { status: 400 })

  const started = Date.now()
  const results: RowResult[] = []
  const pending: string[] = []

  await mapLimit(rows, CONCURRENCY, async (row) => {
    if (Date.now() - started > DEADLINE_MS) {
      pending.push(row.key)
      return
    }
    const items = Array.isArray(row.items) ? row.items : []
    if (!row.erpName || items.length === 0) {
      results.push({ key: row.key, ok: false, error: 'erpName and non-empty items are required' })
      return
    }
    // Merge (append) sheet items into the doc's existing items, keyed by item —
    // other divisions' lines stay intact, matching items overlay, new appended.
    let out
    try {
      out = await mergeChildAppend(DOCTYPE, row.erpName, CHILD_TABLE, items as Record<string, unknown>[])
    } catch (e) {
      results.push({ key: row.key, ok: false, erpName: row.erpName, error: `read existing failed: ${e instanceof Error ? e.message : String(e)}` })
      return
    }
    results.push(
      out.ok
        ? { key: row.key, ok: true, erpName: row.erpName }
        : { key: row.key, ok: false, erpName: row.erpName, error: out.error || `HTTP ${out.status}` },
    )
  })

  const response: BatchResponse = { results, pending }
  return NextResponse.json(response)
}
