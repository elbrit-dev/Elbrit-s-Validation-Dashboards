import 'server-only'
import { ERP, erpConfigured } from './env'
import { fetchRetry } from './retry'

// Thin ERPNext REST client used by the /api/erp/* route handlers. Every helper
// throws with a readable message extracted from frappe's error payloads.

const headers = () => ({
  Authorization: `token ${ERP.key}:${ERP.secret}`,
  Accept: 'application/json',
})

const cleanErr = (s: string) =>
  String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)

export function assertConfigured() {
  if (!erpConfigured()) {
    throw Object.assign(new Error('ERPNext not configured — set ERPNEXT_URL, ERPNEXT_API_KEY, ERPNEXT_API_SECRET.'), { status: 503 })
  }
}

async function getJSON(url: string, label: string): Promise<Record<string, unknown>> {
  const r = await fetchRetry(url, { headers: headers() })
  if (r.ok) return r.json()
  let detail = ''
  try {
    const j = await r.json()
    detail = (j.exception || j.message || j._server_messages || '') as string
  } catch {
    detail = r.statusText
  }
  throw new Error(`${label}: HTTP ${r.status}${detail ? ` — ${cleanErr(detail)}` : ''}`)
}

export interface SendResult {
  ok: boolean
  status: number
  error?: string
  data?: Record<string, unknown>
}

export async function send(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<SendResult> {
  let r: Response
  try {
    r = await fetchRetry(`${ERP.base}${path}`, {
      method,
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) }
  }
  if (r.ok) {
    let data: Record<string, unknown> | undefined
    try { data = ((await r.json()) as { data?: Record<string, unknown> }).data } catch { /* DELETE returns no body */ }
    return { ok: true, status: r.status, data }
  }
  // Surface whatever ERPNext actually said. Read the body once as text, then try
  // JSON (frappe puts the real error in exception / _server_messages / exc). If
  // none of those are present, fall back to the raw body so a 500 is never a bare
  // "HTTP 500" with no clue.
  const raw = await r.text().catch(() => '')
  let detail = ''
  try {
    const j = JSON.parse(raw)
    const msgs = j._server_messages ? tryParseServerMessages(j._server_messages) : ''
    detail = (j.exception || msgs || j.exc || j.message || j._error_message || '') as string
  } catch {
    /* body isn't JSON */
  }
  if (!detail) detail = raw || r.statusText
  return { ok: false, status: r.status, error: cleanErr(detail) }
}

// frappe's _server_messages is a JSON string of JSON strings; pull out the
// human "message" from each. Best-effort — returns '' if the shape is unexpected.
function tryParseServerMessages(s: string): string {
  try {
    const arr = JSON.parse(s) as string[]
    return arr
      .map((m) => {
        try {
          const o = JSON.parse(m) as { message?: string }
          return o.message || m
        } catch {
          return m
        }
      })
      .join(' | ')
  } catch {
    return ''
  }
}

// List documents (frappe list API). Filters use the standard triple format.
export async function listDocs(
  doctype: string,
  filters: unknown[],
  fields: string[],
  { limit = 500, offset = 0, orFilters }: { limit?: number; offset?: number; orFilters?: unknown[] } = {},
): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams({
    fields: JSON.stringify(fields),
    filters: JSON.stringify(filters),
    limit_page_length: String(limit),
    limit_start: String(offset),
  })
  if (orFilters) params.set('or_filters', JSON.stringify(orFilters))
  const json = await getJSON(`${ERP.base}/api/resource/${encodeURIComponent(doctype)}?${params}`, `list ${doctype}`)
  return (json.data as Record<string, unknown>[]) || []
}

// Fetch a single document (with child tables) by name.
export async function getDoc(doctype: string, name: string): Promise<Record<string, unknown> | null> {
  const json = await getJSON(`${ERP.base}/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`, `get ${doctype}`)
  return (json.data as Record<string, unknown>) || null
}

export const createDoc = (doctype: string, doc: Record<string, unknown>) =>
  send('POST', `/api/resource/${encodeURIComponent(doctype)}`, doc)

// Merge the sheet's child rows into an existing doc's table, keyed by `keyField`
// (default 'item'). Existing rows for items THIS sheet isn't touching (other
// divisions' lines) are preserved; existing rows for items we ARE writing are
// dropped and replaced by ALL the incoming rows as-is. Appending the incoming
// set wholesale (rather than overlaying one row per item) preserves legitimate
// duplicates — e.g. "CALBRIT 60K" and "CALBRIT 60K (8 PACKS)" resolve to the
// same UAT item but are two distinct sheet lines that must BOTH appear in ERP.
// Re-running the same sheet is idempotent: its items are dropped, then re-added.
export async function mergeChildAppend(
  doctype: string,
  docName: string,
  childField: string,
  incoming: Record<string, unknown>[],
  keyField = 'item',
): Promise<SendResult> {
  const existing = await getDoc(doctype, docName)
  const existingRows = Array.isArray(existing?.[childField]) ? (existing![childField] as Record<string, unknown>[]) : []
  const incomingKeys = new Set(incoming.map((it) => String(it[keyField] ?? '').trim()).filter(Boolean))
  const kept = existingRows.filter((it) => {
    const k = String(it[keyField] ?? '').trim()
    return k !== '' && !incomingKeys.has(k)
  })
  return updateDoc(doctype, docName, { [childField]: [...kept, ...incoming] })
}

export const updateDoc = (doctype: string, docName: string, patch: Record<string, unknown>) =>
  send('PUT', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(docName)}`, patch)

export const deleteDoc = (doctype: string, docName: string) =>
  send('DELETE', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(docName)}`)

// Cancel a submitted document (needed before deleting submittable doctypes).
export const cancelDoc = (doctype: string, docName: string) =>
  send('PUT', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(docName)}`, { docstatus: 2 })
