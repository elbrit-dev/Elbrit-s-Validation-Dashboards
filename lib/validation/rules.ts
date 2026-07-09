// Validation rule engine — pure functions over sheet rows (via the field
// mapping). Adding a rule here automatically flows through the KPIs, charts,
// issue counts and drilldown.
//
// Rules for Secondary Sales: identity fields (distributor / product / date)
// must be present, and the secondary qty / value must be real numbers.

import { firstValue, CHILD_FIELDS, PARENT_FIELDS } from '../shared/mapping'
import { text } from '../shared/normalize'

export const SEVERITY = {
  error: { key: 'error', label: 'Error', weight: 25, rank: 3 },
  warning: { key: 'warning', label: 'Warning', weight: 8, rank: 2 },
  info: { key: 'info', label: 'Info', weight: 2, rank: 1 },
} as const

export type SeverityKey = keyof typeof SEVERITY

// A row plus its UAT-resolution status (set once "Check with UAT" has run).
export interface RuleContext {
  raw: Record<string, unknown>
  itemStatus?: 'ok' | 'ambiguous' | 'missing'
  distStatus?: 'ok' | 'ambiguous' | 'missing'
}

export interface Rule {
  id: string
  label: string
  severity: SeverityKey
  category: string
  description: string
  fix: string
  test: (ctx: RuleContext) => boolean // true = FAILS the check
}

// Sheet headers for a mapped field key (parent or child).
const headersFor = (key: string): string[] => {
  const f = [...PARENT_FIELDS, ...CHILD_FIELDS].find((x) => x.key === key)
  return f ? f.sheet : []
}
const val = (raw: Record<string, unknown>, key: string): string => firstValue(raw, headersFor(key))
const has = (raw: Record<string, unknown>, key: string) => text(val(raw, key)) !== ''
// A numeric cell that is blank or exactly 0.
const numBlank = (raw: Record<string, unknown>, key: string) => {
  const n = parseFloat(val(raw, key))
  return !Number.isFinite(n) || n === 0
}

export const RULES: Rule[] = [
  {
    id: 'distributor_missing',
    label: 'Missing distributor',
    severity: 'error',
    category: 'Identity',
    description: 'Stockist (distributor) column is blank.',
    fix: 'Fill in the Stockist.',
    test: (c) => !has(c.raw, 'distributor'),
  },
  {
    id: 'item_missing',
    label: 'Missing product',
    severity: 'error',
    category: 'Identity',
    description: 'Product (item) column is blank.',
    fix: 'Fill in the Product.',
    test: (c) => !has(c.raw, 'item'),
  },
  {
    id: 'date_missing',
    label: 'Missing date',
    severity: 'error',
    category: 'Identity',
    description: 'Date column is blank or not a valid date.',
    fix: 'Fill in the Date (YYYY-MM-DD).',
    test: (c) => !has(c.raw, 'date'),
  },
  {
    id: 'item_unresolved',
    label: 'Item not found in UAT',
    severity: 'error',
    category: 'Match',
    description: 'Product does not resolve to a UAT Item (Products).',
    fix: 'Fix the product name in the sheet or add an item alias.',
    test: (c) => c.itemStatus !== undefined && c.itemStatus !== 'ok',
  },
  {
    id: 'distributor_unresolved',
    label: 'Distributor not found in UAT',
    severity: 'error',
    category: 'Match',
    description: 'Stockist does not resolve to a UAT Customer.',
    fix: 'Create the customer in UAT or add a customer alias.',
    test: (c) => c.distStatus !== undefined && c.distStatus !== 'ok',
  },
  {
    id: 'secondary_qty_zero',
    label: 'Secondary qty blank / 0',
    severity: 'warning',
    category: 'Secondary',
    description: 'Secondary (Qty) is blank or 0.',
    fix: 'Enter the secondary sales quantity.',
    test: (c) => numBlank(c.raw, 'sales_qty'),
  },
  {
    id: 'secondary_val_zero',
    label: 'Secondary value blank / 0',
    severity: 'warning',
    category: 'Secondary',
    description: 'Secondary (Val) is blank or 0.',
    fix: 'Enter the secondary sales value.',
    test: (c) => numBlank(c.raw, 'sales_value'),
  },
  {
    id: 'closing_qty_zero',
    label: 'Closing qty blank / 0',
    severity: 'info',
    category: 'Closing',
    description: 'Closing (Qty) is blank or 0.',
    fix: 'Confirm the closing quantity.',
    test: (c) => numBlank(c.raw, 'closing_qty'),
  },
]

export const RULE_BY_ID = Object.fromEntries(RULES.map((r) => [r.id, r]))

export interface RowIssues {
  ruleIds: string[]
  counts: Record<SeverityKey, number>
  score: number
  status: 'error' | 'warning' | 'ready'
}

export function validateRow(ctx: RuleContext): RowIssues {
  const ruleIds: string[] = []
  const counts: Record<SeverityKey, number> = { error: 0, warning: 0, info: 0 }
  for (const rule of RULES) {
    if (rule.test(ctx)) {
      ruleIds.push(rule.id)
      counts[rule.severity]++
    }
  }
  const penalty = counts.error * SEVERITY.error.weight + counts.warning * SEVERITY.warning.weight + counts.info * SEVERITY.info.weight
  const score = Math.max(0, 100 - penalty)
  const status = counts.error > 0 ? 'error' : counts.warning > 0 ? 'warning' : 'ready'
  return { ruleIds, counts, score, status }
}
