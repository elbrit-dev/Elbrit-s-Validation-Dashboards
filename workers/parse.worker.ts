// Parses one xlsx/csv ArrayBuffer off the main thread. Rows are posted back in
// chunks so the page can stream them into IndexedDB with live progress instead
// of receiving one giant message.
import * as XLSX from 'xlsx'
import { detectCodeColumn, rowKey } from '../lib/shared/rowKey'

const CHUNK = 2000

interface ParseRequest {
  buffer: ArrayBuffer
  fileName: string
  monthTag: string
}

const post = (msg: unknown) => (self as unknown as { postMessage: (m: unknown) => void }).postMessage(msg)

self.onmessage = (e: MessageEvent<ParseRequest>) => {
  const { buffer, fileName, monthTag } = e.data
  try {
    const wb = XLSX.read(buffer, { type: 'array' })
    // One month per file → the first sheet carries the data (matches the
    // monthly-file convention; extra sheets are usually pivots/notes).
    const ws = wb.Sheets[wb.SheetNames[0]]
    if (!ws) throw new Error('Workbook has no sheets')
    const json = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: '', raw: false })
    if (json.length === 0) throw new Error('First sheet has no data rows')

    const columns = Object.keys(json[0])
    const codeColumn = detectCodeColumn(columns)
    if (!codeColumn) throw new Error(`No code column found among: ${columns.slice(0, 10).join(', ')}…`)

    for (let i = 0; i < json.length; i += CHUNK) {
      const slice = json.slice(i, i + CHUNK).map((raw) => ({
        key: rowKey(raw, codeColumn, monthTag),
        monthTag,
        fileName,
        raw,
      }))
      post({ type: 'rows', rows: slice, done: Math.min(i + CHUNK, json.length), total: json.length })
    }
    post({ type: 'done', total: json.length, columns, codeColumn, fileName })
  } catch (err) {
    post({ type: 'error', error: err instanceof Error ? err.message : String(err), fileName })
  }
}
