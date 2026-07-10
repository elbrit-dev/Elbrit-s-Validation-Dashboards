'use client'
// Google Drive folder browser with multi-select + editable month tag per file.
import { useEffect, useState } from 'react'
import { listFiles, guessMonthTag } from '@/lib/client/driveClient'
import { getCompletions } from '@/lib/client/db'
import type { DriveFile } from '@/lib/shared/types'

const SHEET_MIME = 'application/vnd.google-apps.spreadsheet'
const fmtSize = (s?: string) => {
  const n = Number(s)
  if (!n) return ''
  return n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`
}

export interface Selected {
  file: DriveFile
  monthTag: string
}

export default function FileBrowser({
  maxSelect = 3,
  disabled,
  onLoad,
}: {
  maxSelect?: number
  disabled?: boolean
  onLoad: (selected: Selected[]) => void
}) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [files, setFiles] = useState<DriveFile[]>([])
  const [selected, setSelected] = useState<Map<string, Selected>>(new Map())
  // fileId → { monthTag, ok, failed } for files already run to UAT.
  const [done, setDone] = useState<Record<string, { monthTag: string; ok: number; failed: number }>>({})

  useEffect(() => {
    getCompletions()
      .then((cs) => setDone(Object.fromEntries(cs.map((c) => [c.fileId, { monthTag: c.monthTag, ok: c.docsOk, failed: c.docsFailed }]))))
      .catch(() => {})
  }, [])

  const refresh = () => {
    setState('loading')
    listFiles()
      .then((f) => {
        setFiles(f)
        setState('ready')
      })
      .catch((e) => {
        setError(e.message)
        setState('error')
      })
  }
  useEffect(refresh, [])

  const toggle = (file: DriveFile) => {
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(file.id)) next.delete(file.id)
      else if (next.size < maxSelect) next.set(file.id, { file, monthTag: guessMonthTag(file.name) })
      return next
    })
  }

  const setTag = (id: string, monthTag: string) => {
    setSelected((prev) => {
      const next = new Map(prev)
      const cur = next.get(id)
      if (cur) next.set(id, { ...cur, monthTag })
      return next
    })
  }

  if (state === 'loading') return <p className="muted">Loading Drive folder…</p>
  if (state === 'error')
    return (
      <div>
        <div className="error-box">Drive: {error}</div>
        <button onClick={refresh}>Retry</button>
      </div>
    )

  return (
    <div>
      <div className="filelist">
        {files.map((f) => {
          const sel = selected.get(f.id)
          const native = f.mimeType === SHEET_MIME
          return (
            <div key={f.id} className={`filecard ${sel ? 'selected' : ''}`}>
              <input type="checkbox" checked={!!sel} disabled={disabled || (!sel && selected.size >= maxSelect)} onChange={() => toggle(f)} />
              <span className="name">
                {f.name}
                {native && (
                  <span className="muted small" title="Native Google Sheet — downloads via server export (10MB Google cap). Prefer real .xlsx files.">
                    {' '}⚠ native Sheet
                  </span>
                )}
              </span>
              {done[f.id] && (
                <span className="pill done" title={`Run to UAT for ${done[f.id].monthTag} — ${done[f.id].ok} docs OK${done[f.id].failed ? `, ${done[f.id].failed} with errors` : ''}`}>
                  ✓ done · {done[f.id].monthTag}
                </span>
              )}
              <span className="muted small">{fmtSize(f.size)}</span>
              {sel && (
                <input
                  type="text"
                  value={sel.monthTag}
                  title="Month tag stamped on every row from this file"
                  onChange={(e) => setTag(f.id, e.target.value)}
                  disabled={disabled}
                />
              )}
            </div>
          )
        })}
        {files.length === 0 && <p className="muted">No sheet files in the folder.</p>}
      </div>
      <div className="row-flex" style={{ marginTop: 12 }}>
        <button className="primary" disabled={disabled || selected.size === 0} onClick={() => onLoad([...selected.values()])}>
          Load {selected.size || ''} file{selected.size === 1 ? '' : 's'}
        </button>
        <span className="muted small">Select up to {maxSelect} monthly sheets — they merge into one session.</span>
      </div>
    </div>
  )
}
