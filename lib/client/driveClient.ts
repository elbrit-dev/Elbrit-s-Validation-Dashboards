// Browser-side Google Drive access. Sheet bytes are downloaded DIRECTLY from
// Google with a short-lived read-only token minted by /api/drive/token — file
// content never passes through a serverless function (no 6MB cap). Native
// Google Sheets fall back to the server proxy (export API isn't CORS-friendly).
import type { DriveFile } from '../shared/types'

const SHEET_MIME = 'application/vnd.google-apps.spreadsheet'

export async function listFiles(): Promise<DriveFile[]> {
  const res = await fetch('/api/drive/files')
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.detail || body.error || `HTTP ${res.status}`)
  return body.files || []
}

let cached: { token: string; expiresAt: number } | null = null
async function getToken(): Promise<string | null> {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token
  const res = await fetch('/api/drive/token')
  if (!res.ok) return null // API-key mode → proxy fallback
  const body = await res.json()
  cached = { token: body.accessToken, expiresAt: body.expiresAt }
  return cached.token
}

export type ProgressFn = (loadedBytes: number, totalBytes: number | null) => void

async function readWithProgress(res: Response, onProgress?: ProgressFn): Promise<ArrayBuffer> {
  const total = Number(res.headers.get('Content-Length')) || null
  if (!res.body || !onProgress) return res.arrayBuffer()
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.byteLength
    onProgress(loaded, total)
  }
  const out = new Uint8Array(loaded)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out.buffer
}

export async function downloadFile(file: DriveFile, onProgress?: ProgressFn): Promise<ArrayBuffer> {
  const isNativeSheet = file.mimeType === SHEET_MIME
  if (!isNativeSheet) {
    const token = await getToken()
    if (token) {
      const url = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      if (res.ok) return readWithProgress(res, onProgress)
      // fall through to proxy on any direct-download failure
    }
  }
  const res = await fetch(`/api/drive/file/${encodeURIComponent(file.id)}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail || body.error || `HTTP ${res.status}`)
  }
  return readWithProgress(res, onProgress)
}

// "Sales March 2026.xlsx" / "2026-03.xlsx" → a best-guess month tag the user
// can correct in the UI.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
export function guessMonthTag(fileName: string): string {
  const lower = fileName.toLowerCase()
  const ym = lower.match(/(20\d{2})[-_ ]?(0[1-9]|1[0-2])/)
  if (ym) return `${ym[1]}-${ym[2]}`
  for (let i = 0; i < MONTHS.length; i++) {
    if (lower.includes(MONTHS[i])) {
      const year = lower.match(/20\d{2}/)?.[0] || String(new Date().getFullYear())
      return `${year}-${String(i + 1).padStart(2, '0')}`
    }
  }
  return fileName.replace(/\.(xlsx|xls|csv)$/i, '')
}
