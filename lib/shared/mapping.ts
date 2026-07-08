// ============================================================================
// FIELD MAPPING — Secondary Sales  →  ERPNext "Secondary Data Entry"
//
// This is the SINGLE place that knows what the sheet columns are, which ERPNext
// doctype/fields they map to, and what identifies a record.
//
// The target doctype is PARENT + CHILD:
//   • Secondary Data Entry  (parent)  — one doc per Distributor + Date
//       - distributor  (Link → Customer)   ← sheet "Stockist"
//       - date         (Date)              ← sheet "Date"
//       - items        (Table → Secondary Data Table)
//   • Secondary Data Table  (child rows)   — one row per product line
//       - item            (Link → Item)   ← sheet "Product"
//       - opening_qty     (Int)           ← sheet "Opening (Qty)"
//       - sales_qty       (Int)           ← sheet "Secondary (Qty)"
//       - sales_value     (Currency)      ← sheet "Secondary (Val)"
//       - closing_qty     (Int)           ← sheet "Closing (Qty)"
//       - closing_balance (Currency)      ← sheet "Closing (Val)"
//
// So MANY sheet rows (same Stockist + Date, different products) collapse into
// ONE parent document with MANY child rows. Identity (rowKey.ts) is the parent
// key: distributor + date.
//
// NOTE on Link values: in UAT, Customers and Items are named by their full
// NAME (e.g. "Maruthi Agencies", "PREGABRIT PLUS"), not by code — so we send the
// sheet's "Stockist" / "Product" text into the Link fields. Case / spelling
// mismatches surface as per-row write errors for you to reconcile.
// ============================================================================

import type { NormKind } from './normalize'

export const DOCTYPE = 'Secondary Data Entry'
export const CHILD_TABLE = 'items' // parent Table fieldname holding child rows
// Not submittable — plain create/update/delete (no cancel step).
export const SUBMITTABLE = false

// Separator joining the parent-identity parts (unit-separator char — never
// appears in real data, so splitKey() round-trips safely).
export const KEY_SEP = '␟'

export interface FieldSpec {
  key: string
  label: string
  /** Candidate sheet headers — the first non-empty one wins. */
  sheet: string[]
  /** ERPNext fieldname. */
  erp: string
  norm: NormKind
}

// Parent fields — one Secondary Data Entry per (distributor, date).
export const PARENT_FIELDS: FieldSpec[] = [
  { key: 'distributor', label: 'Distributor (Customer)', sheet: ['Stockist', 'Stockist Code'], erp: 'distributor', norm: 'text' },
  { key: 'date',        label: 'Date',                   sheet: ['Date'],                       erp: 'date',        norm: 'text' },
]

// Child fields — one Secondary Data Table row per product line.
export const CHILD_FIELDS: FieldSpec[] = [
  { key: 'item',            label: 'Item (Product)', sheet: ['Product', 'Product Code'], erp: 'item',            norm: 'text' },
  { key: 'opening_qty',     label: 'Op. Qty',        sheet: ['Opening (Qty)'],           erp: 'opening_qty',     norm: 'num' },
  { key: 'sales_qty',       label: 'Sec. Qty',       sheet: ['Secondary (Qty)'],         erp: 'sales_qty',       norm: 'num' },
  { key: 'sales_value',     label: 'Sec. Value',     sheet: ['Secondary (Val)'],         erp: 'sales_value',     norm: 'num' },
  { key: 'closing_qty',     label: 'Clos. Qty',      sheet: ['Closing (Qty)'],           erp: 'closing_qty',     norm: 'num' },
  { key: 'closing_balance', label: 'Clos. Value',    sheet: ['Closing (Val)'],           erp: 'closing_balance', norm: 'num' },
]

// Fields fetched from ERPNext to build the parent lookup index (create vs update).
export const ERP_FETCH_FIELDS: string[] = ['name', 'distributor', 'date']

// Sheet cells are truncated with a trailing " ..." (or a "…" ellipsis), e.g.
// "PREGABRIT PLUS ..." — strip it so the value matches the real ERP Item/Customer.
export function stripEllipsis(s: string): string {
  return s.replace(/\s*(?:\.{3,}|…)\s*$/, '').trim()
}

// First non-empty value among a spec's candidate headers (ellipsis stripped).
export function firstValue(raw: Record<string, unknown>, headers: string[]): string {
  for (const h of headers) {
    const v = raw[h]
    if (v != null && String(v).trim() !== '') return stripEllipsis(String(v))
  }
  return ''
}

export const distributorOf = (raw: Record<string, unknown>): string => firstValue(raw, PARENT_FIELDS[0].sheet)
export const dateOf = (raw: Record<string, unknown>): string => normDate(firstValue(raw, PARENT_FIELDS[1].sheet))

// Normalise a sheet date to YYYY-MM-DD (drop any trailing time component).
function normDate(v: string): string {
  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : v.trim()
}

// The parent identity: distributor + date. Empty when either part is missing.
export function parentKey(raw: Record<string, unknown>): string {
  const d = distributorOf(raw)
  const dt = dateOf(raw)
  return d && dt ? `${d}${KEY_SEP}${dt}` : ''
}

export function splitKey(key: string): { distributor: string; date: string } {
  const i = key.indexOf(KEY_SEP)
  return i < 0 ? { distributor: key, date: '' } : { distributor: key.slice(0, i), date: key.slice(i + KEY_SEP.length) }
}

const numOr0 = (v: string): number => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

// Build one child-table row from a sheet row.
export function childRow(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of CHILD_FIELDS) {
    const v = firstValue(raw, f.sheet)
    if (f.norm === 'num') out[f.erp] = numOr0(v)
    else if (v !== '') out[f.erp] = v
  }
  return out
}

// Build a full parent document (with its items child table) from grouped rows.
export function parentDoc(raws: Record<string, unknown>[]): Record<string, unknown> {
  const first = raws[0] || {}
  return {
    distributor: distributorOf(first),
    date: dateOf(first),
    [CHILD_TABLE]: raws.map(childRow),
  }
}
