import { NextResponse } from 'next/server'
import { assertConfigured, createDoc } from '@/lib/server/erpnext'
import { mapLimit } from '@/lib/server/retry'
import { CODE_FIELD, DOCTYPE } from '@/lib/shared/mapping'
import type { BatchResponse, RowResult } from '@/lib/shared/types'

// POST { rows: [{ key, fields: { erpField: value } }] }  (≤ ~40 per call)
// Creates one document per row. Soft deadline: rows not reached before the
// budget are returned as `pending` for the client to re-slice — a slow ERPNext
// can never push a batch past the serverless timeout.
const MAX_ROWS = 50
const CONCURRENCY = 5
const DEADLINE_MS = 8000

interface InRow { key: string; fields: Record<string, string> }

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
    // ⚠ Placeholder doc shape (doctor Lead). lead_name is mandatory on Lead;
    // the real secondary-sales doc shape lands with the mapping swap.
    const doc: Record<string, unknown> = {
      ...row.fields,
      [CODE_FIELD]: row.key,
      lead_name: row.fields.first_name || row.fields.lead_name || `Record ${row.key}`,
    }
    const out = await createDoc(DOCTYPE, doc)
    results.push(
      out.ok
        ? { key: row.key, ok: true, erpName: out.data?.name ? String(out.data.name) : undefined }
        : { key: row.key, ok: false, error: out.error || `HTTP ${out.status}` },
    )
  })

  const response: BatchResponse = { results, pending }
  return NextResponse.json(response)
}
