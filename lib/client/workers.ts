// Typed promise wrappers around the Web Workers.
import type { TriageInputRow, TriageOutputRow } from '../shared/triage'
import type { ErpSummary } from '../shared/types'

export interface ParsedRow {
  key: string
  monthTag: string
  fileName: string
  raw: Record<string, string>
}

export interface ParseDone {
  total: number
  columns: string[]
  codeColumn: string
}

export function parseFile(
  buffer: ArrayBuffer,
  fileName: string,
  monthTag: string,
  onRows: (rows: ParsedRow[], done: number, total: number) => void | Promise<void>,
): Promise<ParseDone> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../../workers/parse.worker.ts', import.meta.url))
    const queue: Promise<void>[] = []
    worker.onmessage = (e) => {
      const msg = e.data
      if (msg.type === 'rows') {
        queue.push(Promise.resolve(onRows(msg.rows, msg.done, msg.total)))
      } else if (msg.type === 'done') {
        Promise.all(queue).then(() => {
          worker.terminate()
          resolve({ total: msg.total, columns: msg.columns, codeColumn: msg.codeColumn })
        })
      } else if (msg.type === 'error') {
        worker.terminate()
        reject(new Error(msg.error))
      }
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(new Error(e.message || 'parse worker failed'))
    }
    worker.postMessage({ buffer, fileName, monthTag }, [buffer])
  })
}

export function triageAll(rows: TriageInputRow[], erpIndex: [string, ErpSummary][]): Promise<TriageOutputRow[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../../workers/triage.worker.ts', import.meta.url))
    worker.onmessage = (e) => {
      worker.terminate()
      if (e.data.type === 'done') resolve(e.data.results)
      else reject(new Error(e.data.error))
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(new Error(e.message || 'triage worker failed'))
    }
    worker.postMessage({ rows, erpIndex })
  })
}

export function exportXlsx(sheets: { name: string; rows: Record<string, unknown>[] }[], fileName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../../workers/export.worker.ts', import.meta.url))
    worker.onmessage = (e) => {
      worker.terminate()
      if (e.data.type === 'done') {
        const blob = new Blob([e.data.buffer], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        })
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = e.data.fileName
        a.click()
        URL.revokeObjectURL(a.href)
        resolve()
      } else reject(new Error(e.data.error))
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(new Error(e.message || 'export worker failed'))
    }
    worker.postMessage({ sheets, fileName })
  })
}
