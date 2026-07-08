import { NextResponse } from 'next/server'
import { assertConfigured, updateDoc } from '@/lib/server/erpnext'
import { mapLimit } from '@/lib/server/retry'
import { DOCTYPE } from '@/lib/shared/mapping'
import type { BatchResponse, RowResult } from '@/lib/shared/types'

// POST { rows: [{ key, erpName, fields: { erpField: value } }] }  (≤ ~40/call)
// Writes ONLY the changed fields the client's triage found. Rows are keyed by
// distinct erpName so no document is ever written concurrently.
const MAX_ROWS = 50
const CONCURRENCY = 5
const DEADLINE_MS = 8000

interface InRow { key: string; erpName: string; fields: Record<string, string> }

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
    if (!row.erpName || !row.fields || Object.keys(row.fields).length === 0) {
      results.push({ key: row.key, ok: false, error: 'erpName and non-empty fields are required' })
      return
    }
    const out = await updateDoc(DOCTYPE, row.erpName, row.fields)
    results.push(
      out.ok
        ? { key: row.key, ok: true, erpName: row.erpName }
        : { key: row.key, ok: false, erpName: row.erpName, error: out.error || `HTTP ${out.status}` },
    )
  })

  const response: BatchResponse = { results, pending }
  return NextResponse.json(response)
}
