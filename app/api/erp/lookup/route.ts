import { NextResponse } from 'next/server'
import { assertConfigured, listDocs } from '@/lib/server/erpnext'
import { DOCTYPE, ERP_FETCH_FIELDS, KEY_SEP, splitKey } from '@/lib/shared/mapping'
import type { ErpSummary } from '@/lib/shared/types'

// POST { codes: string[] }  — each "code" is a parent key "distributor␟date".
// Returns { records: { [key]: ErpSummary } } for the create-vs-update decision.
// We fetch every Secondary Data Entry whose distributor is in the requested set
// AND whose date is in the requested set, then match exact (distributor, date)
// pairs — so an existing parent means UPDATE, a missing one means CREATE.
const MAX_CODES = 100

export async function POST(req: Request) {
  try {
    assertConfigured()
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 })
  }
  const body = await req.json().catch(() => ({}))
  const keys: string[] = Array.isArray(body?.codes) ? body.codes.filter((k: unknown) => typeof k === 'string' && k.includes(KEY_SEP)) : []
  if (keys.length === 0) return NextResponse.json({ records: {}, requested: 0, found: 0 })
  if (keys.length > MAX_CODES) return NextResponse.json({ error: `Max ${MAX_CODES} keys per call` }, { status: 400 })

  const requested = new Set(keys)
  const distributors = [...new Set(keys.map((k) => splitKey(k).distributor))]
  const dates = [...new Set(keys.map((k) => splitKey(k).date))]

  try {
    const docs = await listDocs(
      DOCTYPE,
      [
        ['distributor', 'in', distributors],
        ['date', 'in', dates],
      ],
      ERP_FETCH_FIELDS,
      { limit: MAX_CODES * 10 },
    )

    const records: Record<string, ErpSummary> = {}
    for (const d of docs) {
      const key = `${String(d.distributor ?? '')}${KEY_SEP}${String(d.date ?? '')}`
      if (!requested.has(key) || records[key]) continue
      const fields: Record<string, string> = {}
      for (const f of ERP_FETCH_FIELDS) fields[f] = d[f] == null ? '' : String(d[f])
      records[key] = { name: String(d.name), code: key, fields }
    }
    return NextResponse.json({ records, requested: keys.length, found: Object.keys(records).length })
  } catch (err) {
    return NextResponse.json({ error: 'ERPNext lookup failed', detail: err instanceof Error ? err.message : String(err) }, { status: 502 })
  }
}
