import { NextResponse } from 'next/server'
import { assertConfigured, listDocs } from '@/lib/server/erpnext'
import { DOCTYPE, CHILD_DOCTYPE } from '@/lib/shared/mapping'

// POST { customers: string[], from?: string, to?: string }
//   → { rows: ErpLine[] }
// One row per Secondary Data Table child line for the given customers (optionally
// scoped to a date range), carrying the 5 quantity/value figures AND the
// sales-team mapping (role profile / HQ / department) exactly as posted in ERP.
// Queries the parent Secondary Data Entry with the child table referenced by
// backtick, so frappe returns one joined row per child line (same technique the
// auto-mapping uses against Item + Elbrit Department Table).
export interface ErpLine {
  customer: string
  date: string
  item: string
  opening_qty: number
  sales_qty: number
  sales_value: number
  closing_qty: number
  closing_balance: number
  custom_role_profile: string
  custom_hq: string
  custom_department: string
}

const MAX_CUSTOMERS = 500
const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const str = (v: unknown): string => (v == null ? '' : String(v))

export async function POST(req: Request) {
  try {
    assertConfigured()
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 })
  }
  const body = await req.json().catch(() => ({}))
  const customers: string[] = Array.isArray(body?.customers)
    ? [...new Set((body.customers as unknown[]).filter((c): c is string => typeof c === 'string' && c.trim() !== ''))]
    : []
  if (customers.length === 0) return NextResponse.json({ rows: [], count: 0 })
  if (customers.length > MAX_CUSTOMERS) return NextResponse.json({ error: `Max ${MAX_CUSTOMERS} customers per call` }, { status: 400 })
  const from = typeof body?.from === 'string' ? body.from : ''
  const to = typeof body?.to === 'string' ? body.to : ''

  const child = '`tab' + CHILD_DOCTYPE + '`'
  const filters: unknown[] = [['distributor', 'in', customers]]
  if (from && to) filters.push(['date', 'between', [from, to]])
  else if (from) filters.push(['date', '>=', from])
  else if (to) filters.push(['date', '<=', to])

  try {
    const docs = await listDocs(
      DOCTYPE,
      filters,
      [
        'distributor',
        'date',
        `${child}.\`item\` as item`,
        `${child}.\`opening_qty\` as opening_qty`,
        `${child}.\`sales_qty\` as sales_qty`,
        `${child}.\`sales_value\` as sales_value`,
        `${child}.\`closing_qty\` as closing_qty`,
        `${child}.\`closing_balance\` as closing_balance`,
        `${child}.\`custom_role_profile\` as custom_role_profile`,
        `${child}.\`custom_hq\` as custom_hq`,
        `${child}.\`custom_department\` as custom_department`,
      ],
      { limit: 20000 },
    )
    const rows: ErpLine[] = docs
      .filter((d) => str(d.item).trim() !== '')
      .map((d) => ({
        customer: str(d.distributor),
        date: str(d.date),
        item: str(d.item),
        opening_qty: num(d.opening_qty),
        sales_qty: num(d.sales_qty),
        sales_value: num(d.sales_value),
        closing_qty: num(d.closing_qty),
        closing_balance: num(d.closing_balance),
        custom_role_profile: str(d.custom_role_profile),
        custom_hq: str(d.custom_hq),
        custom_department: str(d.custom_department),
      }))
    return NextResponse.json({ rows, count: rows.length })
  } catch (err) {
    return NextResponse.json(
      { error: 'ERPNext secondary lines fetch failed', detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    )
  }
}
