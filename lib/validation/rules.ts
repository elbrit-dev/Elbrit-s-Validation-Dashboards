// Validation rule engine — pure functions over sheet rows (via the field
// mapping). Adding a rule here automatically flows through the KPIs, charts,
// issue counts and drilldown, exactly like the doctor dashboard.
//
// ⚠ PLACEHOLDER RULES (doctor fields) — swapped together with lib/shared/mapping.ts
// when the real secondary-sales fields arrive.

import { sheetValue, FIELD_MAP } from '../shared/mapping'
import { phone as normPhone, text } from '../shared/normalize'

export const SEVERITY = {
  error: { key: 'error', label: 'Error', weight: 25, rank: 3 },
  warning: { key: 'warning', label: 'Warning', weight: 8, rank: 2 },
  info: { key: 'info', label: 'Info', weight: 2, rank: 1 },
} as const

export type SeverityKey = keyof typeof SEVERITY

export interface Rule {
  id: string
  label: string
  severity: SeverityKey
  category: string
  description: string
  fix: string
  test: (raw: Record<string, unknown>) => boolean // true = FAILS the check
}

const field = (key: string) => FIELD_MAP.find((f) => f.key === key)
const val = (raw: Record<string, unknown>, key: string): string => {
  const f = field(key)
  return f ? sheetValue(raw, f.sheet) : ''
}
const has = (raw: Record<string, unknown>, key: string) => text(val(raw, key)) !== ''
const numBlank = (raw: Record<string, unknown>, key: string) => {
  const n = parseFloat(val(raw, key))
  return !Number.isFinite(n) || n === 0
}

export const RULES: Rule[] = [
  {
    id: 'name_missing',
    label: 'Missing name',
    severity: 'error',
    category: 'Identity',
    description: 'Name column is blank.',
    fix: 'Enter the name.',
    test: (raw) => !has(raw, 'name'),
  },
  {
    id: 'geo_missing',
    label: 'Missing geo-coordinates',
    severity: 'error',
    category: 'Geo',
    description: 'Latitude/longitude is blank or 0.',
    fix: 'Fill in the latitude and longitude.',
    test: (raw) => numBlank(raw, 'latitude') || numBlank(raw, 'longitude'),
  },
  {
    id: 'territory_missing',
    label: 'Missing territory (HQ)',
    severity: 'error',
    category: 'Org',
    description: 'No HQ / territory value on the row.',
    fix: 'Fill in the HQ.',
    test: (raw) => !has(raw, 'territory'),
  },
  {
    id: 'speciality_missing',
    label: 'Missing speciality',
    severity: 'warning',
    category: 'Classification',
    description: 'Speciality is blank.',
    fix: 'Fill in the speciality.',
    test: (raw) => !has(raw, 'specialty'),
  },
  {
    id: 'qualification_missing',
    label: 'Missing qualification',
    severity: 'warning',
    category: 'Classification',
    description: 'Qualification is blank.',
    fix: 'Fill in the qualification.',
    test: (raw) => !has(raw, 'qualification'),
  },
  {
    id: 'category_missing',
    label: 'Missing category',
    severity: 'warning',
    category: 'Classification',
    description: 'Category is blank.',
    fix: 'Fill in the category.',
    test: (raw) => !has(raw, 'category'),
  },
  {
    id: 'contact_missing',
    label: 'Missing contact number',
    severity: 'warning',
    category: 'Contact',
    description: 'No usable contact number (blank or placeholder).',
    fix: 'Fill in a valid 10-digit contact number.',
    test: (raw) => normPhone(val(raw, 'mobile')) === '',
  },
  {
    id: 'city_missing',
    label: 'Missing city',
    severity: 'warning',
    category: 'Address',
    description: 'City is blank.',
    fix: 'Fill in the city.',
    test: (raw) => !has(raw, 'city'),
  },
  {
    id: 'state_missing',
    label: 'Missing state',
    severity: 'warning',
    category: 'Address',
    description: 'State is blank.',
    fix: 'Fill in the state.',
    test: (raw) => !has(raw, 'state'),
  },
]

export const RULE_BY_ID = Object.fromEntries(RULES.map((r) => [r.id, r]))

export interface RowIssues {
  ruleIds: string[]
  counts: Record<SeverityKey, number>
  score: number
  status: 'error' | 'warning' | 'ready'
}

export function validateRow(raw: Record<string, unknown>): RowIssues {
  const ruleIds: string[] = []
  const counts: Record<SeverityKey, number> = { error: 0, warning: 0, info: 0 }
  for (const rule of RULES) {
    if (rule.test(raw)) {
      ruleIds.push(rule.id)
      counts[rule.severity]++
    }
  }
  const penalty = counts.error * SEVERITY.error.weight + counts.warning * SEVERITY.warning.weight + counts.info * SEVERITY.info.weight
  const score = Math.max(0, 100 - penalty)
  const status = counts.error > 0 ? 'error' : counts.warning > 0 ? 'warning' : 'ready'
  return { ruleIds, counts, score, status }
}
