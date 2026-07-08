// Builds the results workbook off the main thread and transfers the bytes back.
import * as XLSX from 'xlsx'

interface ExportRequest {
  sheets: { name: string; rows: Record<string, unknown>[] }[]
  fileName: string
}

const post = (msg: unknown, transfer?: Transferable[]) =>
  (self as unknown as { postMessage: (m: unknown, t?: Transferable[]) => void }).postMessage(msg, transfer)

self.onmessage = (e: MessageEvent<ExportRequest>) => {
  try {
    const wb = XLSX.utils.book_new()
    for (const s of e.data.sheets) {
      const ws = XLSX.utils.json_to_sheet(s.rows.length ? s.rows : [{ note: 'empty' }])
      XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31))
    }
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
    post({ type: 'done', buffer: out, fileName: e.data.fileName }, [out])
  } catch (err) {
    post({ type: 'error', error: err instanceof Error ? err.message : String(err) })
  }
}
