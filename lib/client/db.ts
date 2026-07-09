// IndexedDB session store (Dexie). Replaces the doctor tool's localStorage —
// holds the full parsed rows, the ERP lookup index and per-row run results, so
// a 30k-row session survives reloads and resumes mid-run.
import Dexie, { type Table } from 'dexie'
import type { ChangedField, ErpSummary, RunStatus, TriageAction } from '../shared/types'

export interface SessionRec {
  id: string
  createdAt: number
  updatedAt: number
  files: { id: string; name: string; monthTag: string }[]
  phase: 'parsed' | 'triaged' | 'running' | 'done'
  codeColumn: string
  columns: string[]
}

export interface RowRec {
  rid?: number
  sessionId: string
  key: string
  monthTag: string
  fileName: string
  raw: Record<string, string>
  action?: TriageAction
  erpName?: string | null
  changed?: ChangedField[]
  // Item-name resolution against UAT (nomenclature matching).
  resolvedItem?: string // canonical UAT Item name when itemStatus === 'ok'
  itemStatus?: 'ok' | 'ambiguous' | 'missing'
  itemOptions?: string[] // candidate names when ambiguous
  // Stockist → UAT Customer resolution (the distributor link).
  resolvedDistributor?: string // canonical UAT Customer name when distStatus === 'ok'
  distStatus?: 'ok' | 'ambiguous' | 'missing'
  distOptions?: string[]
  // Sales-team auto-mapping (ERPNext "Apply Mapping").
  custom_role_profile?: string
  custom_hq?: string
  custom_department?: string
  mapStatus?: 'ok' | 'conflict' | 'unmapped'
  mapDepartments?: string[]
  runOp?: 'create' | 'update'
  runStatus?: RunStatus
  runError?: string
  runResultName?: string
}

export interface ErpIndexRec {
  sessionId: string
  code: string
  name: string
  fields: Record<string, string>
}

class AppDB extends Dexie {
  sessions!: Table<SessionRec, string>
  rows!: Table<RowRec, number>
  erpIndex!: Table<ErpIndexRec, [string, string]>

  constructor() {
    super('secondary-data-entry')
    this.version(1).stores({
      sessions: 'id, createdAt',
      rows: '++rid, sessionId, [sessionId+key], [sessionId+action], [sessionId+runStatus]',
      erpIndex: '[sessionId+code], sessionId',
    })
  }
}

let db: AppDB | null = null
export function getDb(): AppDB {
  if (!db) db = new AppDB()
  return db
}

export async function latestSession(): Promise<SessionRec | undefined> {
  return getDb().sessions.orderBy('createdAt').last()
}

export async function clearSession(sessionId: string): Promise<void> {
  const d = getDb()
  await Promise.all([
    d.rows.where('sessionId').equals(sessionId).delete(),
    d.erpIndex.where('sessionId').equals(sessionId).delete(),
    d.sessions.delete(sessionId),
  ])
}

export async function erpIndexMap(sessionId: string): Promise<Map<string, ErpSummary>> {
  const recs = await getDb().erpIndex.where('sessionId').equals(sessionId).toArray()
  return new Map(recs.map((r) => [r.code, { name: r.name, code: r.code, fields: r.fields }]))
}

// Ask the browser not to evict our data under storage pressure.
export async function requestPersistence(): Promise<void> {
  try {
    if (navigator.storage?.persist) await navigator.storage.persist()
  } catch {
    /* best effort */
  }
}
