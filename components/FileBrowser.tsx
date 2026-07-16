'use client'
// Google Drive folder browser with multi-select + editable month tag per file.
import { useEffect, useState } from 'react'
import { listFiles, guessMonthTag } from '@/lib/client/driveClient'
import { getCompletions } from '@/lib/client/db'
import type { DriveFile } from '@/lib/shared/types'

const SHEET_MIME = 'application/vnd.google-apps.spreadsheet'
const FOLDER_MIME = 'application/vnd.google-apps.folder'
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
  // Breadcrumb of the folders we've drilled into (root is implicit / empty).
  // The last entry's id is the folder currently being listed.
  const [path, setPath] = useState<{ id: string; name: string }[]>([])
  // fileId → { monthTag, ok, failed } for files already run to UAT.
  const [done, setDone] = useState<Record<string, { monthTag: string; ok: number; failed: number }>>({})

  useEffect(() => {
    getCompletions()
      .then((cs) => setDone(Object.fromEntries(cs.map((c) => [c.fileId, { monthTag: c.monthTag, ok: c.docsOk, failed: c.docsFailed }]))))
      .catch(() => {})
  }, [])

  const currentFolderId = path.length ? path[path.length - 1].id : undefined

  const refresh = () => {
    setState('loading')
    listFiles(currentFolderId)
      .then((f) => {
        setFiles(f)
        setState('ready')
      })
      .catch((e) => {
        setError(e.message)
        setState('error')
      })
  }
  // Re-list whenever we navigate into / out of a folder.
  useEffect(refresh, [currentFolderId])

  // Drill into a sub-folder / jump to a breadcrumb level. Selections persist
  // across folders (they're keyed by file id), so you can gather sheets from
  // more than one folder into a single load.
  const openFolder = (f: DriveFile) => setPath((p) => [...p, { id: f.id, name: f.name }])
  const goToLevel = (level: number) => setPath((p) => p.slice(0, level))

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

  // Breadcrumb: "Drive folder" (root) → each folder we've opened.
  const breadcrumb = (
    <div className="row-flex small" style={{ gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
      <button className="linklike" disabled={disabled || path.length === 0} onClick={() => goToLevel(0)}>
        📁 Drive folder
      </button>
      {path.map((p, i) => (
        <span key={p.id} className="row-flex" style={{ gap: 6 }}>
          <span className="muted">/</span>
          <button className="linklike" disabled={disabled || i === path.length - 1} onClick={() => goToLevel(i + 1)}>
            {p.name}
          </button>
        </span>
      ))}
    </div>
  )

  if (state === 'loading')
    return (
      <div>
        {breadcrumb}
        <p className="muted">Loading Drive folder…</p>
      </div>
    )
  if (state === 'error')
    return (
      <div>
        {breadcrumb}
        <div className="error-box">Drive: {error}</div>
        <button onClick={refresh}>Retry</button>
      </div>
    )

  const folders = files.filter((f) => f.mimeType === FOLDER_MIME)
  const sheets = files.filter((f) => f.mimeType !== FOLDER_MIME)

  return (
    <div>
      {breadcrumb}
      <div className="filelist">
        {folders.map((f) => (
          <div key={f.id} className="filecard folder" role="button" tabIndex={0}
            onClick={() => !disabled && openFolder(f)}
            onKeyDown={(e) => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) openFolder(f) }}
            style={{ cursor: disabled ? 'default' : 'pointer' }}>
            <span aria-hidden>📁</span>
            <span className="name">{f.name}</span>
            <span className="muted small">open →</span>
          </div>
        ))}
        {sheets.map((f) => {
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
        {files.length === 0 && <p className="muted">This folder is empty.</p>}
        {files.length > 0 && sheets.length === 0 && (
          <p className="muted">No sheet files here — open a sub-folder above to find them.</p>
        )}
      </div>
      {selected.size > 0 && (
        <p className="muted small" style={{ marginTop: 8 }}>
          {selected.size} file{selected.size === 1 ? '' : 's'} selected{' '}
          <span>({[...selected.values()].map((s) => s.file.name).join(', ')})</span>
        </p>
      )}
      <div className="row-flex" style={{ marginTop: 12 }}>
        <button className="primary" disabled={disabled || selected.size === 0} onClick={() => onLoad([...selected.values()])}>
          Load {selected.size || ''} file{selected.size === 1 ? '' : 's'}
        </button>
        <span className="muted small">Select up to {maxSelect} monthly sheets — they merge into one session.</span>
      </div>
    </div>
  )
}
