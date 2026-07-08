// Pure triage engine: given sheet rows and the ERP parent index, decide what
// each row's parent needs (create / update / conflict). Runs in the triage
// worker — no DOM, no fetch, no state.
//
// The unit written to ERPNext is the PARENT (distributor + date), whose child
// `items` table is rebuilt from every sheet row that shares the key. So triage
// is per-parent: if the parent exists in UAT it's an UPDATE (items replaced
// wholesale), otherwise a CREATE. Every row inheriting a key gets that action.
// Rows with no key (missing distributor or date) are conflicts.

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

export function triageRows(rows: TriageInputRow[], erpIndex: Map<string, ErpSummary>): TriageOutputRow[] {
  return rows.map((r) => {
    if (!r.key) return { key: r.key, action: 'conflict' as const, erpName: null, changed: [] }
    const erp = erpIndex.get(r.key)
    if (!erp) return { key: r.key, action: 'create' as const, erpName: null, changed: [] }
    // Parent already in UAT → update (its `items` table is replaced on write).
    return { key: r.key, action: 'update' as const, erpName: erp.name, changed: [] }
  })
}
