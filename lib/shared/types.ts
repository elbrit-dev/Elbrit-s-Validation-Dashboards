// Shared shapes across pages, workers and API routes.

export type TriageAction = 'create' | 'update' | 'unchanged' | 'conflict'
export type RunStatus = 'pending' | 'done' | 'error'

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime?: string
  size?: string
}

export interface ChangedField {
  key: string
  label: string
  erpField: string
  sheetVal: string
  erpVal: string
}

/** ERPNext record summary held in the lookup index. */
export interface ErpSummary {
  name: string
  code: string
  fields: Record<string, string>
}

/** Per-row write result returned by the create/update/delete routes. */
export interface RowResult {
  key: string
  ok: boolean
  erpName?: string
  error?: string
}

export interface BatchResponse {
  results: RowResult[]
  /** Row keys the handler did not reach before its soft deadline — re-slice. */
  pending: string[]
}
