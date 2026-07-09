import { NextResponse } from 'next/server'
import { assertConfigured, createDoc, listDocs, mergeChildAppend } from '@/lib/server/erpnext'
import { mapLimit } from '@/lib/server/retry'
import { CHILD_TABLE, DOCTYPE } from '@/lib/shared/mapping'
import type { BatchResponse, RowResult } from '@/lib/shared/types'

// POST { rows: [{ key, doc: { distributor, date, items: [...] } }] }  (≤ 50/call)
// Each row is ONE parent Secondary Data Entry (distributor + date) carrying its
// full `items` child table. Idempotent/upsert: if a doc for that distributor +
// date already exists (prior run, retry, or another spelling of the same
// customer), we APPEND the items into it instead of failing on the duplicate
// autoname. Soft deadline: rows not reached come back as `pending` to re-slice.
const MAX_ROWS = 50
const CONCURRENCY = 5
const DEADLINE_MS = 8000

interface InRow { key: string; doc: Record<string, unknown> }

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
    const doc = row.doc || {}
    const items = Array.isArray(doc[CHILD_TABLE]) ? (doc[CHILD_TABLE] as unknown[]) : []
    if (!doc.distributor || !doc.date || items.length === 0) {
      results.push({ key: row.key, ok: false, error: 'distributor, date and at least one item are required' })
      return
    }
    let out = await createDoc(DOCTYPE, doc)
    let erpName = out.data?.name ? String(out.data.name) : undefined

    // Doc already exists (duplicate autoname) → append items into it instead.
    if (!out.ok && /duplicate|already exists/i.test(out.error || '')) {
      try {
        const found = await listDocs(DOCTYPE, [['distributor', '=', doc.distributor], ['date', '=', doc.date]], ['name'], { limit: 1 })
        const name = found[0]?.name ? String(found[0].name) : ''
        if (name) {
          out = await mergeChildAppend(DOCTYPE, name, CHILD_TABLE, items as Record<string, unknown>[])
          erpName = name
        }
      } catch (e) {
        out = { ok: false, status: 0, error: `merge into existing failed: ${e instanceof Error ? e.message : String(e)}` }
      }
    }

    results.push(
      out.ok
        ? { key: row.key, ok: true, erpName }
        : { key: row.key, ok: false, error: out.error || `HTTP ${out.status}` },
    )
  })

  const response: BatchResponse = { results, pending }
  return NextResponse.json(response)
}
