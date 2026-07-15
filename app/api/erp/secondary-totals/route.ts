import { NextResponse } from 'next/server'
import { assertConfigured, listDocs } from '@/lib/server/erpnext'
import { DOCTYPE, CHILD_DOCTYPE } from '@/lib/shared/mapping'

// POST { customers: string[], from?: string, to?: string }
//   → { totals: { [customer]: Totals }, docCount: { [customer]: number } }
//
// Fetches what is ALREADY posted in ERP for the given customers so the EBS
// Validation view can show "sheet vs ERP" side by side. We:
//   1) page the Secondary Data Entry parents (name, distributor, date) — bounded
//      to the sheet's date range so we compare like-for-like months, not the
//      customer's all-time history — and keep the ones whose distributor is in
//      the requested set;
//   2) page the Secondary Data Table child rows for those parents and sum the
//      quantity/value fields per customer.
// The parent key is the RESOLVED customer name (the parent's `distributor` link),
// which is exactly what the client groups the sheet rows by.

const TOTAL_KEYS = ['opening_qty', 'sales_qty', 'sales_value', 'closing_qty', 'closing_balance'] as const
type TotalKey = (typeof TOTAL_KEYS)[number]
type Totals = Record<TotalKey, number>
const zero = (): Totals => ({ opening_qty: 0, sales_qty: 0, sales_value: 0, closing_qty: 0, closing_balance: 0 })

const PAGE = 500
const HARD_CAP = 200000
const PARENT_CHUNK = 80 // parent names per child-row query (keeps the `in` filter / URL small)
const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export async function POST(req: Request) {
  try {
    assertConfigured()
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 })
  }

  const body = await req.json().catch(() => ({}))
  const wanted = new Set(
    (Array.isArray(body?.customers) ? body.customers : [])
      .filter((c: unknown): c is string => typeof c === 'string' && c.trim() !== ''),
  )
  const from = typeof body?.from === 'string' && body.from.trim() ? body.from.trim() : null
  const to = typeof body?.to === 'string' && body.to.trim() ? body.to.trim() : null
  if (wanted.size === 0) return NextResponse.json({ totals: {}, docCount: {} })

  const dateFilters: unknown[] = []
  if (from) dateFilters.push(['date', '>=', from])
  if (to) dateFilters.push(['date', '<=', to])

  try {
    // 1) parents in range → parentName → customer (only the ones we care about)
    const parentCustomer = new Map<string, string>()
    let offset = 0
    for (;;) {
      const docs = await listDocs(DOCTYPE, dateFilters, ['name', 'distributor', 'date'], { limit: PAGE, offset })
      for (const d of docs) {
        const cust = String(d.distributor ?? '')
        if (wanted.has(cust)) parentCustomer.set(String(d.name), cust)
      }
      if (docs.length < PAGE) break
      offset += docs.length
      if (offset > HARD_CAP) break
    }

    const totals: Record<string, Totals> = {}
    const docCount: Record<string, number> = {}
    for (const cust of parentCustomer.values()) docCount[cust] = (docCount[cust] ?? 0) + 1

    // 2) child rows for those parents, aggregated per customer
    const parentNames = [...parentCustomer.keys()]
    for (let i = 0; i < parentNames.length; i += PARENT_CHUNK) {
      const chunk = parentNames.slice(i, i + PARENT_CHUNK)
      let coff = 0
      for (;;) {
        const rows = await listDocs(
          CHILD_DOCTYPE,
          [['parent', 'in', chunk], ['parenttype', '=', DOCTYPE]],
          ['parent', ...TOTAL_KEYS],
          { limit: PAGE, offset: coff },
        )
        for (const r of rows) {
          const cust = parentCustomer.get(String(r.parent))
          if (!cust) continue
          const t = (totals[cust] ??= zero())
          for (const k of TOTAL_KEYS) t[k] += num(r[k])
        }
        if (rows.length < PAGE) break
        coff += rows.length
        if (coff > HARD_CAP) break
      }
    }

    return NextResponse.json({ totals, docCount })
  } catch (err) {
    return NextResponse.json(
      { error: 'ERP secondary totals failed', detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    )
  }
}
