'use client'
// Secondary entry flow: pick monthly Drive sheets → parse (worker) → check
// against ERPNext UAT (chunked lookup) → triage (worker) → batched
// create / update / delete runs with pause + resume. All heavy data lives in
// IndexedDB, so a reload never loses a 30k-row session.
import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import ErrorBoundary from '@/components/ErrorBoundary'
import FileBrowser, { type Selected } from '@/components/FileBrowser'
import VirtualTable, { type VColumn } from '@/components/VirtualTable'
import { downloadFile } from '@/lib/client/driveClient'
import { parseFile, triageAll, exportXlsx } from '@/lib/client/workers'
import { runInBatches } from '@/lib/client/batchRunner'
import { getDb, latestSession, clearSession, requestPersistence, type RowRec, type SessionRec } from '@/lib/client/db'
import { erpPayload, RECORD_LABEL } from '@/lib/shared/mapping'
import type { ErpSummary, RowResult, TriageAction } from '@/lib/shared/types'

const LOOKUP_CHUNK = 90
const WRITE_BATCH = 40
const PUT_CHUNK = 5000

type Busy =
  | { kind: 'none' }
  | { kind: 'load'; label: string; pct: number | null }
  | { kind: 'lookup'; done: number; total: number }
  | { kind: 'triage' }
  | { kind: 'run'; op: string; done: number; total: number }
  | { kind: 'scan'; count: number }

interface Health {
  erp: { configured: boolean; base: string | null }
  drive: { configured: boolean; mode: string }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function bulkPutChunked(rows: RowRec[]) {
  const db = getDb()
  for (let i = 0; i < rows.length; i += PUT_CHUNK) {
    await db.rows.bulkPut(rows.slice(i, i + PUT_CHUNK))
  }
}

export default function EntryPage() {
  const [health, setHealth] = useState<Health | null>(null)
  const [session, setSession] = useState<SessionRec | null>(null)
  const [rows, setRows] = useState<RowRec[]>([])
  const [busy, setBusy] = useState<Busy>({ kind: 'none' })
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'all' | TriageAction | 'failed'>('all')
  const [doCreate, setDoCreate] = useState(true)
  const [doUpdate, setDoUpdate] = useState(true)
  const [drawer, setDrawer] = useState<RowRec | null>(null)
  const [paused, setPaused] = useState(false)
  const signal = useRef({ paused: false, aborted: false })
  // delete flow (danger — gated)
  const [deleteCandidates, setDeleteCandidates] = useState<{ name: string; code: string }[] | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deleteResults, setDeleteResults] = useState<RowResult[] | null>(null)

  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then(setHealth).catch(() => setHealth(null))
    requestPersistence()
    latestSession().then(async (s) => {
      if (!s) return
      setSession(s)
      const r = await getDb().rows.where('sessionId').equals(s.id).toArray()
      r.sort((a, b) => (a.rid || 0) - (b.rid || 0))
      setRows(r)
    })
  }, [])

  const refreshRows = async (sessionId: string) => {
    const r = await getDb().rows.where('sessionId').equals(sessionId).toArray()
    r.sort((a, b) => (a.rid || 0) - (b.rid || 0))
    setRows(r)
    return r
  }

  // ---- step 1: download + parse selected files ------------------------------
  const startLoad = async (selected: Selected[]) => {
    setError('')
    setDeleteCandidates(null)
    setDeleteResults(null)
    try {
      const db = getDb()
      // one session at a time — clear anything older
      const old = await db.sessions.toArray()
      for (const s of old) await clearSession(s.id)

      const id = `s${Date.now()}`
      let codeColumn = ''
      let columns: string[] = []
      for (const sel of selected) {
        setBusy({ kind: 'load', label: `Downloading ${sel.file.name}…`, pct: null })
        const buf = await downloadFile(sel.file, (loaded, total) =>
          setBusy({ kind: 'load', label: `Downloading ${sel.file.name}…`, pct: total ? Math.round((loaded / total) * 100) : null }),
        )
        setBusy({ kind: 'load', label: `Parsing ${sel.file.name}…`, pct: null })
        const done = await parseFile(buf, sel.file.name, sel.monthTag, async (parsed, doneCount, total) => {
          await db.rows.bulkAdd(parsed.map((p) => ({ sessionId: id, key: p.key, monthTag: p.monthTag, fileName: p.fileName, raw: p.raw })))
          setBusy({ kind: 'load', label: `Parsing ${sel.file.name} — ${doneCount.toLocaleString()}/${total.toLocaleString()} rows`, pct: Math.round((doneCount / total) * 100) })
        })
        codeColumn = done.codeColumn
        columns = done.columns
      }
      const rec: SessionRec = {
        id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        files: selected.map((s) => ({ id: s.file.id, name: s.file.name, monthTag: s.monthTag })),
        phase: 'parsed',
        codeColumn,
        columns,
      }
      await db.sessions.put(rec)
      setSession(rec)
      await refreshRows(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy({ kind: 'none' })
    }
  }

  // ---- step 2: chunked UAT lookup + triage ----------------------------------
  const checkWithUat = async () => {
    if (!session) return
    setError('')
    try {
      const db = getDb()
      const keys = [...new Set(rows.map((r) => r.key).filter(Boolean))]
      await db.erpIndex.where('sessionId').equals(session.id).delete()

      const indexEntries: [string, ErpSummary][] = []
      for (let i = 0; i < keys.length; i += LOOKUP_CHUNK) {
        const slice = keys.slice(i, i + LOOKUP_CHUNK)
        let ok = false
        let lastErr = ''
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
          try {
            const res = await fetch('/api/erp/lookup', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ codes: slice }),
            })
            const body = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(body.detail || body.error || `HTTP ${res.status}`)
            const records = body.records as Record<string, ErpSummary>
            const recs = Object.values(records)
            await db.erpIndex.bulkPut(recs.map((r) => ({ sessionId: session.id, code: r.code, name: r.name, fields: r.fields })))
            for (const r of recs) indexEntries.push([r.code, r])
            ok = true
          } catch (e) {
            lastErr = e instanceof Error ? e.message : String(e)
            if (attempt < 2) await sleep(1200 * (attempt + 1))
          }
        }
        if (!ok) throw new Error(`UAT lookup failed: ${lastErr}`)
        setBusy({ kind: 'lookup', done: Math.min(i + LOOKUP_CHUNK, keys.length), total: keys.length })
      }

      setBusy({ kind: 'triage' })
      const results = await triageAll(rows.map((r) => ({ key: r.key, raw: r.raw })), indexEntries)
      const byIdx = new Map<number, RowRec>()
      rows.forEach((r, i) => byIdx.set(i, r))
      const updated = rows.map((r, i) => ({
        ...r,
        action: results[i].action,
        erpName: results[i].erpName,
        changed: results[i].changed,
        runStatus: undefined,
        runError: undefined,
      }))
      await bulkPutChunked(updated)
      const rec = { ...session, phase: 'triaged' as const, updatedAt: Date.now() }
      await getDb().sessions.put(rec)
      setSession(rec)
      setRows(updated)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy({ kind: 'none' })
    }
  }

  // ---- step 3: batched create/update runs -----------------------------------
  const applyResults = async (results: RowResult[], op: 'create' | 'update', byKey: Map<string, RowRec>) => {
    const touched: RowRec[] = []
    for (const res of results) {
      const row = byKey.get(res.key)
      if (!row) continue
      row.runOp = op
      row.runStatus = res.ok ? 'done' : 'error'
      row.runError = res.error
      row.runResultName = res.erpName
      touched.push(row)
    }
    await bulkPutChunked(touched)
    setRows((prev) => [...prev])
  }

  const startRun = async () => {
    if (!session) return
    setError('')
    setPaused(false)
    signal.current = { paused: false, aborted: false }
    try {
      const creates = doCreate ? rows.filter((r) => r.action === 'create' && r.runStatus !== 'done') : []
      const updates = doUpdate ? rows.filter((r) => r.action === 'update' && r.runStatus !== 'done') : []
      const total = creates.length + updates.length
      let base = 0
      const rec = { ...session, phase: 'running' as const, updatedAt: Date.now() }
      await getDb().sessions.put(rec)
      setSession(rec)

      if (creates.length > 0) {
        const byKey = new Map(creates.map((r) => [r.key, r]))
        setBusy({ kind: 'run', op: 'Creating', done: 0, total })
        await runInBatches({
          items: creates,
          batchSize: WRITE_BATCH,
          endpoint: '/api/erp/create',
          keyOf: (r) => r.key,
          buildBody: (slice) => ({ rows: slice.map((r) => ({ key: r.key, fields: erpPayload(r.raw) })) }),
          onResult: (res) => applyResults(res, 'create', byKey),
          onProgress: (done) => setBusy({ kind: 'run', op: 'Creating', done: base + done, total }),
          signal: signal.current,
        })
        base += creates.length
      }
      if (updates.length > 0 && !signal.current.aborted) {
        const byKey = new Map(updates.map((r) => [r.key, r]))
        setBusy({ kind: 'run', op: 'Updating', done: base, total })
        await runInBatches({
          items: updates,
          batchSize: WRITE_BATCH,
          endpoint: '/api/erp/update',
          keyOf: (r) => r.key,
          buildBody: (slice) => ({
            rows: slice.map((r) => ({
              key: r.key,
              erpName: r.erpName,
              fields: Object.fromEntries((r.changed || []).map((c) => [c.erpField, c.sheetVal])),
            })),
          }),
          onResult: (res) => applyResults(res, 'update', byKey),
          onProgress: (done) => setBusy({ kind: 'run', op: 'Updating', done: base + done, total }),
          signal: signal.current,
        })
      }
      const rec2 = { ...session, phase: 'done' as const, updatedAt: Date.now() }
      await getDb().sessions.put(rec2)
      setSession(rec2)
      await refreshRows(session.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy({ kind: 'none' })
      setPaused(false)
    }
  }

  const togglePause = () => {
    signal.current.paused = !signal.current.paused
    setPaused(signal.current.paused)
  }
  const abortRun = () => {
    signal.current.aborted = true
    signal.current.paused = false
  }

  // ---- delete (danger, gated) ------------------------------------------------
  const scanForDeletes = async () => {
    if (!session) return
    setError('')
    setDeleteResults(null)
    try {
      const sheetKeys = new Set(rows.map((r) => r.key).filter(Boolean))
      const all: { name: string; code: string }[] = []
      let offset: number | null = 0
      while (offset !== null) {
        const res: Response = await fetch('/api/erp/list', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ offset, limit: 500 }),
        })
        const body: { records?: { name: string; code: string }[]; nextOffset?: number | null; detail?: string; error?: string } =
          await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.detail || body.error || `HTTP ${res.status}`)
        all.push(...(body.records || []))
        offset = body.nextOffset ?? null
        setBusy({ kind: 'scan', count: all.length })
      }
      setDeleteCandidates(all.filter((r) => r.code && !sheetKeys.has(r.code)))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy({ kind: 'none' })
    }
  }

  const runDeletes = async () => {
    if (!deleteCandidates || deleteConfirm !== 'DELETE') return
    setError('')
    signal.current = { paused: false, aborted: false }
    const collected: RowResult[] = []
    try {
      setBusy({ kind: 'run', op: 'Deleting', done: 0, total: deleteCandidates.length })
      await runInBatches({
        items: deleteCandidates,
        batchSize: WRITE_BATCH,
        endpoint: '/api/erp/delete',
        keyOf: (r) => r.name,
        buildBody: (slice) => ({ names: slice.map((r) => r.name) }),
        onResult: (res) => {
          collected.push(...res)
          setDeleteResults([...collected])
        },
        onProgress: (done) => setBusy({ kind: 'run', op: 'Deleting', done, total: deleteCandidates.length }),
        signal: signal.current,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy({ kind: 'none' })
      setDeleteConfirm('')
    }
  }

  // ---- export -----------------------------------------------------------------
  const doExport = async () => {
    const toRow = (r: RowRec) => ({
      key: r.key,
      month: r.monthTag,
      file: r.fileName,
      action: r.action || '',
      erpRecord: r.runResultName || r.erpName || '',
      runStatus: r.runStatus || '',
      error: r.runError || '',
      changedFields: (r.changed || []).map((c) => c.label).join(', '),
      ...r.raw,
    })
    const failures = rows.filter((r) => r.runStatus === 'error')
    await exportXlsx(
      [
        { name: 'All rows', rows: rows.map(toRow) },
        { name: 'Failures', rows: failures.map(toRow) },
        {
          name: 'Summary',
          rows: [
            { metric: 'Total rows', value: rows.length },
            ...(['create', 'update', 'unchanged', 'conflict'] as const).map((a) => ({ metric: a, value: counts[a] })),
            { metric: 'Written OK', value: rows.filter((r) => r.runStatus === 'done').length },
            { metric: 'Write errors', value: failures.length },
          ],
        },
      ],
      `secondary-run-${session?.id || 'export'}.xlsx`,
    )
  }

  // ---- derived ----------------------------------------------------------------
  const counts = useMemo(() => {
    const c = { create: 0, update: 0, unchanged: 0, conflict: 0, done: 0, failed: 0 }
    for (const r of rows) {
      if (r.action) c[r.action]++
      if (r.runStatus === 'done') c.done++
      if (r.runStatus === 'error') c.failed++
    }
    return c
  }, [rows])

  const monthCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) m.set(r.monthTag, (m.get(r.monthTag) || 0) + 1)
    return [...m.entries()]
  }, [rows])

  const visible = useMemo(() => {
    if (tab === 'all') return rows
    if (tab === 'failed') return rows.filter((r) => r.runStatus === 'error')
    return rows.filter((r) => r.action === tab)
  }, [rows, tab])

  const triaged = session?.phase === 'triaged' || session?.phase === 'running' || session?.phase === 'done'
  const isBusy = busy.kind !== 'none'

  const columns: VColumn<RowRec>[] = [
    { key: 'key', header: 'Code', width: 110, render: (r) => <span className="mono">{r.key || '—'}</span> },
    { key: 'month', header: 'Month', width: 90, render: (r) => r.monthTag },
    {
      key: 'name',
      header: RECORD_LABEL,
      width: 260,
      render: (r) => String(r.raw[session?.codeColumn ? Object.keys(r.raw).find((k) => /name/i.test(k)) || '' : ''] ?? ''),
    },
    { key: 'action', header: 'Action', width: 110, render: (r) => (r.action ? <span className={`pill ${r.action}`}>{r.action}</span> : <span className="muted">—</span>) },
    { key: 'changed', header: 'Changed fields', width: 260, render: (r) => (r.changed || []).map((c) => c.label).join(', ') },
    {
      key: 'run',
      header: 'Run',
      width: 180,
      render: (r) =>
        r.runStatus === 'done' ? <span className="pill done">✓ {r.runOp}</span> : r.runStatus === 'error' ? <span className="pill error" title={r.runError}>✗ {r.runError?.slice(0, 40)}</span> : <span className="muted">—</span>,
    },
  ]

  return (
    <ErrorBoundary>
      <div className="row-flex spread" style={{ marginBottom: 14 }}>
        <Steps session={session} />
        <div className="row-flex">
          <HealthBadge health={health} />
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      <section className="panel">
        <h2>
          1 · Drive sheets
          <span className="hint">pick 2–3 monthly files — bytes download straight from Google, not through the server</span>
        </h2>
        <FileBrowser disabled={isBusy} onLoad={startLoad} />
        {busy.kind === 'load' && (
          <div className="row-flex" style={{ marginTop: 12 }}>
            <div className="progress"><div style={{ width: `${busy.pct ?? 30}%` }} /></div>
            <span className="muted small">{busy.label}</span>
          </div>
        )}
      </section>

      {session && rows.length > 0 && (
        <section className="panel">
          <h2>
            2 · Loaded rows
            <span className="hint">
              {rows.length.toLocaleString()} rows · {monthCounts.map(([m, n]) => `${m}: ${n.toLocaleString()}`).join(' · ')}
            </span>
          </h2>
          <div className="row-flex" style={{ marginBottom: 12 }}>
            <button className="primary" onClick={checkWithUat} disabled={isBusy || !health?.erp.configured}>
              Check with UAT {triaged ? '(re-run)' : ''}
            </button>
            {busy.kind === 'lookup' && (
              <>
                <div className="progress"><div style={{ width: `${(busy.done / busy.total) * 100}%` }} /></div>
                <span className="muted small">Looking up {busy.done.toLocaleString()}/{busy.total.toLocaleString()} codes…</span>
              </>
            )}
            {busy.kind === 'triage' && <span className="muted small">Diffing rows against UAT…</span>}
            {!health?.erp.configured && <span className="warn-box small" style={{ margin: 0 }}>ERPNext env not configured</span>}
            <span style={{ flex: 1 }} />
            <button className="danger" disabled={isBusy} onClick={async () => { if (session) { await clearSession(session.id); setSession(null); setRows([]); setDeleteCandidates(null) } }}>
              Clear session
            </button>
          </div>

          {triaged && (
            <>
              <div className="kpis">
                <div className="kpi green"><div className="label">To create</div><div className="value">{counts.create.toLocaleString()}</div></div>
                <div className="kpi blue"><div className="label">To update</div><div className="value">{counts.update.toLocaleString()}</div></div>
                <div className="kpi"><div className="label">Unchanged</div><div className="value">{counts.unchanged.toLocaleString()}</div></div>
                <div className="kpi amber"><div className="label">Conflicts</div><div className="value">{counts.conflict.toLocaleString()}</div></div>
                <div className="kpi green"><div className="label">Written OK</div><div className="value">{counts.done.toLocaleString()}</div></div>
                <div className="kpi red"><div className="label">Write errors</div><div className="value">{counts.failed.toLocaleString()}</div></div>
              </div>

              <div className="row-flex" style={{ marginBottom: 12 }}>
                <label className="row-flex small"><input type="checkbox" checked={doCreate} onChange={(e) => setDoCreate(e.target.checked)} /> create {counts.create.toLocaleString()}</label>
                <label className="row-flex small"><input type="checkbox" checked={doUpdate} onChange={(e) => setDoUpdate(e.target.checked)} /> update {counts.update.toLocaleString()}</label>
                <button className="primary" onClick={startRun} disabled={isBusy || (!doCreate && !doUpdate)}>
                  Run to UAT
                </button>
                {busy.kind === 'run' && (
                  <>
                    <div className="progress"><div style={{ width: `${(busy.done / Math.max(busy.total, 1)) * 100}%` }} /></div>
                    <span className="muted small">{busy.op} {busy.done.toLocaleString()}/{busy.total.toLocaleString()}</span>
                    <button onClick={togglePause}>{paused ? 'Resume' : 'Pause'}</button>
                    <button className="danger" onClick={abortRun}>Stop</button>
                  </>
                )}
                {session.phase === 'done' && busy.kind === 'none' && <span className="ok-box small" style={{ margin: 0 }}>Run finished — re-running skips rows already written.</span>}
                <span style={{ flex: 1 }} />
                <button onClick={doExport} disabled={isBusy}>⬇ Export results</button>
                <Link href="/validation"><button disabled={isBusy}>Validation view →</button></Link>
              </div>
            </>
          )}

          <div className="tabs">
            {(['all', 'create', 'update', 'unchanged', 'conflict', 'failed'] as const).map((t) => (
              <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                {t}{t !== 'all' && ` (${t === 'failed' ? counts.failed : counts[t] ?? 0})`}
              </button>
            ))}
          </div>
          <VirtualTable rows={visible} columns={columns} onRowClick={setDrawer} empty="No rows in this view" />
        </section>
      )}

      {triaged && (
        <section className="panel">
          <h2>
            3 · Delete extra UAT records
            <span className="hint">danger zone — finds UAT records whose code is missing from the loaded sheets</span>
          </h2>
          <div className="row-flex">
            <button onClick={scanForDeletes} disabled={isBusy}>Scan UAT for extra records</button>
            {busy.kind === 'scan' && <span className="muted small">Scanned {busy.count.toLocaleString()} records…</span>}
            {deleteCandidates && (
              <>
                <span className="small">{deleteCandidates.length.toLocaleString()} candidates</span>
                <input type="text" placeholder='type DELETE to enable' value={deleteConfirm} onChange={(e) => setDeleteConfirm(e.target.value)} />
                <button className="danger" disabled={isBusy || deleteConfirm !== 'DELETE' || deleteCandidates.length === 0} onClick={runDeletes}>
                  Delete {deleteCandidates.length.toLocaleString()} records
                </button>
              </>
            )}
          </div>
          {deleteCandidates && deleteCandidates.length > 0 && (
            <div className="warn-box">
              ⚠ These UAT records have no row in the loaded sheets. With the current placeholder mapping this can list records from other months —
              only delete when the loaded sheets are the complete window you mean to enforce.
            </div>
          )}
          {deleteResults && (
            <p className="small muted">
              Deleted OK: {deleteResults.filter((r) => r.ok).length.toLocaleString()} · failed: {deleteResults.filter((r) => !r.ok).length.toLocaleString()}
            </p>
          )}
        </section>
      )}

      {drawer && <RowDrawer row={drawer} onClose={() => setDrawer(null)} />}
    </ErrorBoundary>
  )
}

function Steps({ session }: { session: SessionRec | null }) {
  const phase = session?.phase
  const items = [
    { n: 1, label: 'Load sheets', done: !!session },
    { n: 2, label: 'Check with UAT', done: phase === 'triaged' || phase === 'running' || phase === 'done' },
    { n: 3, label: 'Run', done: phase === 'done' },
  ]
  return (
    <div className="steps">
      {items.map((s) => (
        <div key={s.n} className={`step ${s.done ? 'done-step' : ''}`}>
          <span className="n">{s.done ? '✓' : s.n}</span> {s.label}
        </div>
      ))}
    </div>
  )
}

function HealthBadge({ health }: { health: Health | null }) {
  if (!health) return <span className="badge"><span className="dot gray" />connecting…</span>
  const ok = health.erp.configured
  return (
    <span className="badge" title={health.erp.base || ''}>
      <span className={`dot ${ok ? '' : 'red'}`} />
      {ok ? 'ERPNext UAT connected' : 'ERPNext not configured'} · Drive: {health.drive.mode}
    </span>
  )
}

function RowDrawer({ row, onClose }: { row: RowRec; onClose: () => void }) {
  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="drawer">
        <div className="row-flex spread">
          <h3 className="mono">{row.key || '(no code)'}</h3>
          <button onClick={onClose}>Close</button>
        </div>
        <p className="muted small">
          {row.fileName} · {row.monthTag}
          {row.action && <> · <span className={`pill ${row.action}`}>{row.action}</span></>}
          {row.erpName && <> · UAT: <span className="mono">{row.erpName}</span></>}
        </p>
        {row.runStatus && (
          <div className={row.runStatus === 'done' ? 'ok-box' : 'error-box'}>
            {row.runStatus === 'done' ? `Written (${row.runOp}) → ${row.runResultName || row.erpName}` : `Write failed: ${row.runError}`}
          </div>
        )}
        {(row.changed?.length ?? 0) > 0 && (
          <>
            <h4>Changed fields</h4>
            <div className="kv">
              {row.changed!.map((c) => (
                <div key={c.key} style={{ display: 'contents' }}>
                  <span className="k">{c.label}</span>
                  <span>
                    <span className="mono">{c.erpVal || '∅'}</span> → <span className="mono" style={{ color: 'var(--green)' }}>{c.sheetVal || '∅'}</span>
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
        <h4>Sheet row</h4>
        <div className="kv">
          {Object.entries(row.raw).map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <span className="k">{k}</span>
              <span>{String(v)}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
