import { NextResponse } from 'next/server'
import { assertConfigured, listDocs } from '@/lib/server/erpnext'
import { DOCTYPE, KEY_SEP } from '@/lib/shared/mapping'

// POST { offset?: number, limit?: number }
// Pages through ALL Secondary Data Entry parents. Used to build the full-window
// index that powers delete-candidate detection. The client loops offsets until
// a short page comes back. `code` is the parent key (distributor␟date) so it can
// be compared against the loaded sheet keys.
export async function POST(req: Request) {
  try {
    assertConfigured()
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 })
  }
  const body = await req.json().catch(() => ({}))
  const offset = Number(body?.offset) || 0
  const limit = Math.min(Number(body?.limit) || 500, 500)
  try {
    const docs = await listDocs(DOCTYPE, [], ['name', 'distributor', 'date'], { limit, offset })
    const records = docs.map((d) => ({
      name: String(d.name),
      code: `${String(d.distributor ?? '')}${KEY_SEP}${String(d.date ?? '')}`,
    }))
    return NextResponse.json({ records, nextOffset: docs.length < limit ? null : offset + docs.length })
  } catch (err) {
    return NextResponse.json({ error: 'ERPNext list failed', detail: err instanceof Error ? err.message : String(err) }, { status: 502 })
  }
}
