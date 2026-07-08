import { NextResponse } from 'next/server'
import { assertConfigured, listDocs } from '@/lib/server/erpnext'
import { CODE_FIELD, DOCTYPE, NAME_PREFIX } from '@/lib/shared/mapping'
import { code as stripZeros } from '@/lib/shared/normalize'

// POST { offset?: number, limit?: number }
// Pages through ALL coded records of the doctype (name like "<PREFIX>%").
// Used to build the full-window index that powers delete-candidate detection.
// The client loops offsets until a short page comes back.
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
    const docs = await listDocs(DOCTYPE, [['name', 'like', `${NAME_PREFIX}%`]], ['name', CODE_FIELD], { limit, offset })
    const records = docs.map((d) => ({
      name: String(d.name),
      code:
        stripZeros(d[CODE_FIELD]) ||
        stripZeros(String(d.name).slice(NAME_PREFIX.length)),
    }))
    return NextResponse.json({ records, nextOffset: docs.length < limit ? null : offset + docs.length })
  } catch (err) {
    return NextResponse.json({ error: 'ERPNext list failed', detail: err instanceof Error ? err.message : String(err) }, { status: 502 })
  }
}
