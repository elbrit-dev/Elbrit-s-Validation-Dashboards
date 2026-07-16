import 'server-only'
import { DRIVE } from './env'
import { authFor, driveConfigured, driveStatusDetail } from './googleAuth'
import type { DriveFile } from '../shared/types'

export const SHEET_MIME = 'application/vnd.google-apps.spreadsheet'
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
export const FOLDER_MIME = 'application/vnd.google-apps.folder'
const ACCEPTED = new Set([SHEET_MIME, XLSX_MIME, 'application/vnd.ms-excel', 'text/csv'])

// List the accepted sheet files AND sub-folders inside a folder. Folders are
// kept so the browser can drill into them (sheets are often nested one level
// deep, e.g. a per-region "Elbrit AP" folder); folderId defaults to the root
// configured folder.
export async function listFolderFiles(folderId?: string): Promise<DriveFile[]> {
  if (!driveConfigured()) throw new Error(driveStatusDetail() || 'Google Drive not configured.')
  const { headers, keyParam } = await authFor()
  const parent = folderId || DRIVE.folderId
  const params = new URLSearchParams({
    q: `'${parent}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType,modifiedTime,size)',
    orderBy: 'folder,name', // folders first, then files, each alphabetical
    pageSize: '200',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  })
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}${keyParam}`, { headers })
  if (!res.ok) throw new Error(`Google Drive list failed: HTTP ${res.status} ${await res.text().catch(() => '')}`)
  const json = await res.json()
  const files = (json.files || []) as DriveFile[]
  return files.filter((f) => f.mimeType === FOLDER_MIME || ACCEPTED.has(f.mimeType) || /\.(xlsx|xls|csv)$/i.test(f.name || ''))
}

// Server-side download fallback (native Google Sheets export, or when the
// browser's direct download fails). Big .xlsx files should NOT come this way —
// the browser downloads them straight from Google with the minted token.
export async function downloadFile(fileId: string): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
  if (!driveConfigured()) throw new Error(driveStatusDetail() || 'Google Drive not configured.')
  const { headers, keyParam } = await authFor()

  const metaParams = new URLSearchParams({ fields: 'id,name,mimeType', supportsAllDrives: 'true' })
  const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?${metaParams}${keyParam}`, { headers })
  if (!metaRes.ok) throw new Error(`Google Drive metadata failed: HTTP ${metaRes.status}`)
  const meta = await metaRes.json()
  const isSheet = meta.mimeType === SHEET_MIME

  const url = isSheet
    ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(XLSX_MIME)}${keyParam}`
    : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true${keyParam}`
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`Google Drive download failed: HTTP ${res.status} ${await res.text().catch(() => '')}`)
  const buffer = Buffer.from(await res.arrayBuffer())
  const filename = isSheet ? `${meta.name || 'sheet'}.xlsx` : meta.name || 'sheet.xlsx'
  return { buffer, filename, contentType: isSheet ? XLSX_MIME : res.headers.get('content-type') || XLSX_MIME }
}
