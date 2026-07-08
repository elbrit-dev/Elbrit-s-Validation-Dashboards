// Pure triage engine: given sheet rows and the ERP lookup index, decide what
// each row needs (create / update / unchanged / conflict) and which fields
// changed. Runs in the triage worker — no DOM, no fetch, no state.

import { FIELD_MAP, sheetValue } from './mapping'
import { sameValue, normalizeBy, isBlank } from './normalize'
import type { ChangedField, ErpSummary, TriageAction } from './types'

export interface TriageInputRow {
  key: string
  raw: Record<string, unknown>
}

export interface TriageOutputRow {
  key: string
  action: TriageAction
  erpName: string | null
  changed: ChangedField[]
}

// Diff one sheet row against its ERP record. A field counts as changed only
// when the sheet HAS a value and it differs from ERP after normalization —
// blank sheet cells never blank-out ERP values (same rule as the doctor tool).
export function diffRow(raw: Record<string, unknown>, erp: ErpSummary): ChangedField[] {
  const changed: ChangedField[] = []
  for (const f of FIELD_MAP) {
    if (f.createOnly) continue
    const sv = sheetValue(raw, f.sheet)
    if (isBlank(normalizeBy(f.norm, sv))) continue
    const ev = erp.fields[f.erp] ?? ''
    if (!sameValue(f.norm, sv, ev)) {
      changed.push({ key: f.key, label: f.label, erpField: f.erp, sheetVal: String(sv).trim(), erpVal: String(ev).trim() })
    }
  }
  return changed
}

export function triageRows(rows: TriageInputRow[], erpIndex: Map<string, ErpSummary>): TriageOutputRow[] {
  // Keys that appear more than once in the merged sheets are conflicts — the
  // user must resolve which row wins before any write happens.
  const seen = new Map<string, number>()
  for (const r of rows) seen.set(r.key, (seen.get(r.key) || 0) + 1)

  return rows.map((r) => {
    if (!r.key) return { key: r.key, action: 'conflict' as const, erpName: null, changed: [] }
    if ((seen.get(r.key) || 0) > 1) return { key: r.key, action: 'conflict' as const, erpName: null, changed: [] }
    const erp = erpIndex.get(r.key)
    if (!erp) return { key: r.key, action: 'create' as const, erpName: null, changed: [] }
    const changed = diffRow(r.raw, erp)
    return { key: r.key, action: changed.length > 0 ? ('update' as const) : ('unchanged' as const), erpName: erp.name, changed }
  })
}
