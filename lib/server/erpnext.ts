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
  let detail = ''
  try {
    const j = await r.json()
    detail = (j.exception || j._server_messages || j.message || '') as string
  } catch {
    detail = r.statusText
  }
  return { ok: false, status: r.status, error: cleanErr(detail) }
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

export const createDoc = (doctype: string, doc: Record<string, unknown>) =>
  send('POST', `/api/resource/${encodeURIComponent(doctype)}`, doc)

export const updateDoc = (doctype: string, docName: string, patch: Record<string, unknown>) =>
  send('PUT', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(docName)}`, patch)

export const deleteDoc = (doctype: string, docName: string) =>
  send('DELETE', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(docName)}`)

// Cancel a submitted document (needed before deleting submittable doctypes).
export const cancelDoc = (doctype: string, docName: string) =>
  send('PUT', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(docName)}`, { docstatus: 2 })
