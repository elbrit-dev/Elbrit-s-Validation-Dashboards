import { NextResponse } from 'next/server'
import { assertConfigured, listDocs } from '@/lib/server/erpnext'
import { CODE_FIELD, DOCTYPE, ERP_FETCH_FIELDS, NAME_PREFIX } from '@/lib/shared/mapping'
import { code as stripZeros } from '@/lib/shared/normalize'
import type { ErpSummary } from '@/lib/shared/types'

// POST { codes: string[] }  (≤ ~90 per call — the client slices)
// Returns { records: { [code]: ErpSummary } } for diffing. Zero-padding
// tolerant: matches both the code field and the "<PREFIX><code>" doc name.
const MAX_CODES = 100
const pad8 = (c: string) => c.padStart(8, '0')

export async function POST(req: Request) {
  try {
    assertConfigured()
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 })
  }
  const body = await req.json().catch(() => ({}))
  const codes: string[] = Array.isArray(body?.codes) ? body.codes.map(stripZeros).filter(Boolean) : []
  if (codes.length === 0) return NextResponse.json({ error: 'codes[] is required' }, { status: 400 })
  if (codes.length > MAX_CODES) return NextResponse.json({ error: `Max ${MAX_CODES} codes per call` }, { status: 400 })

  const codeVariants = codes.flatMap((c) => [c, pad8(c)])
  const nameVariants = codes.flatMap((c) => [`${NAME_PREFIX}${c}`, `${NAME_PREFIX}${pad8(c)}`])

  try {
    const [byCode, byName] = await Promise.all([
      listDocs(DOCTYPE, [[CODE_FIELD, 'in', codeVariants]], ERP_FETCH_FIELDS, { limit: MAX_CODES * 3 }),
      listDocs(DOCTYPE, [['name', 'in', nameVariants]], ERP_FETCH_FIELDS, { limit: MAX_CODES * 3 }),
    ])
    const requested = new Set(codes)
    const records: Record<string, ErpSummary> = {}
    const docs = new Map<string, Record<string, unknown>>()
    for (const d of [...byCode, ...byName]) docs.set(String(d.name), d)

    for (const d of docs.values()) {
      const docName = String(d.name)
      const c =
        stripZeros(d[CODE_FIELD]) ||
        (docName.startsWith(NAME_PREFIX) ? stripZeros(docName.slice(NAME_PREFIX.length)) : '')
      if (!c || !requested.has(c)) continue
      // Prefer the clean "<PREFIX><code>" document when duplicates share a code.
      if (!records[c] || docName === `${NAME_PREFIX}${c}`) {
        const fields: Record<string, string> = {}
        for (const f of ERP_FETCH_FIELDS) fields[f] = d[f] == null ? '' : String(d[f])
        records[c] = { name: docName, code: c, fields }
      }
    }
    return NextResponse.json({ records, requested: codes.length, found: Object.keys(records).length })
  } catch (err) {
    return NextResponse.json({ error: 'ERPNext lookup failed', detail: err instanceof Error ? err.message : String(err) }, { status: 502 })
  }
}
