import { NextResponse } from 'next/server'
import { assertConfigured, cancelDoc, deleteDoc } from '@/lib/server/erpnext'
import { mapLimit } from '@/lib/server/retry'
import { DOCTYPE, SUBMITTABLE } from '@/lib/shared/mapping'
import type { BatchResponse, RowResult } from '@/lib/shared/types'

// POST { names: string[] }  (≤ ~40 per call)
// DANGER path — the UI keeps it behind an explicit opt-in. Submittable
// doctypes are cancelled first, then deleted.
const MAX_ROWS = 50
const CONCURRENCY = 4
const DEADLINE_MS = 8000

export async function POST(req: Request) {
  try {
    assertConfigured()
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 })
  }
  const body = await req.json().catch(() => ({}))
  const names: string[] = Array.isArray(body?.names) ? body.names.filter(Boolean) : []
  if (names.length === 0) return NextResponse.json({ error: 'names[] is required' }, { status: 400 })
  if (names.length > MAX_ROWS) return NextResponse.json({ error: `Max ${MAX_ROWS} names per call` }, { status: 400 })

  const started = Date.now()
  const results: RowResult[] = []
  const pending: string[] = []

  await mapLimit(names, CONCURRENCY, async (docName) => {
    if (Date.now() - started > DEADLINE_MS) {
      pending.push(docName)
      return
    }
    if (SUBMITTABLE) {
      const c = await cancelDoc(DOCTYPE, docName)
      // "already cancelled / draft" errors are fine to ignore; real failures stop the row.
      if (!c.ok && c.status !== 417 && !/cancel/i.test(c.error || '')) {
        results.push({ key: docName, ok: false, erpName: docName, error: `cancel: ${c.error || `HTTP ${c.status}`}` })
        return
      }
    }
    const out = await deleteDoc(DOCTYPE, docName)
    results.push(
      out.ok
        ? { key: docName, ok: true, erpName: docName }
        : { key: docName, ok: false, erpName: docName, error: out.error || `HTTP ${out.status}` },
    )
  })

  const response: BatchResponse = { results, pending }
  return NextResponse.json(response)
}
