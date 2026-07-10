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
import { childRow, distributorOf, dateOf, firstValue, splitKey, KEY_SEP, isSkippedProduct } from '@/lib/shared/mapping'
import type { ErpSummary, RowResult, TriageAction, MappingResult } from '@/lib/shared/types'

const LOOKUP_CHUNK = 90
const WRITE_BATCH = 40
const PUT_CHUNK = 5000

type Busy =
  | { kind: 'none' }
  | { kind: 'load'; label: string; pct: number | null }
  | { kind: 'lookup'; done: number; total: number }
  | { kind: 'resolve'; done: number; total: number }
  | { kind: 'triage' }
  | { kind: 'run'; op: string; done: number; total: number }
  | { kind: 'scan'; count: number }

// Result of matching a sheet product / stockist to a canonical UAT record.
type ItemMatch = { status: 'ok' | 'ambiguous' | 'missing'; name: string; options?: string[] }
type CustomerMatch = ItemMatch

// POST JSON with 3 retries + backoff; throws with the server's error message.
async function postJson(endpoint: string, body: unknown): Promise<Record<string, unknown>> {
  let lastErr = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((json.detail as string) || (json.error as string) || `HTTP ${res.status}`)
      return json
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
      if (attempt < 2) await sleep(1200 * (attempt + 1))
    }
  }
  throw new Error(lastErr || 'request failed')
}

interface Health {
  erp: { configured: boolean; base: string | null }
  drive: { configured: boolean; mode: string }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// A write unit: all sheet rows sharing one parent key (distributor + date).
interface WriteGroup {
  key: string
  erpName?: string | null
  rows: RowRec[]
}

// Collapse rows into parent groups, preserving the ERP name carried by triage.
function groupRows(rs: RowRec[]): WriteGroup[] {
  const m = new Map<string, WriteGroup>()
  for (const r of rs) {
    let g = m.get(r.key)
    if (!g) {
      g = { key: r.key, erpName: r.erpName, rows: [] }
      m.set(r.key, g)
    }
    g.rows.push(r)
  }
  return [...m.values()]
}

// Why a row is a problem — the conflict reason (unresolved distributor/item, or
// no key) or the ERP write error. Empty string when the row is fine.
function rowProblem(r: RowRec): string {
  if (r.runStatus === 'error') return `write failed: ${r.runError || 'unknown error'}`
  if (r.action === 'conflict') {
    if (!r.key) return 'missing distributor or date'
    if (r.distStatus === 'missing') return 'distributor (customer) not found in UAT'
    if (r.distStatus === 'ambiguous') return `distributor ambiguous: ${(r.distOptions || []).join(' | ')}`
    if (r.itemStatus === 'missing') return 'item not found in UAT (Products)'
    if (r.itemStatus === 'ambiguous') return `item ambiguous: ${(r.itemOptions || []).join(' | ')}`
    return 'conflict'
  }
  return ''
}

// Build a parent's child `items`, using the canonical UAT Item name resolved at
// check time (falls back to the raw product name — but such rows are conflicts
// and never reach a write group).
function groupItems(rs: RowRec[]): Record<string, unknown>[] {
  return rs.map((r) => {
    const line: Record<string, unknown> = { ...childRow(r.raw), item: r.resolvedItem || firstValue(r.raw, ['Product', 'Product Code']) }
    if (r.custom_role_profile) line.custom_role_profile = r.custom_role_profile
    if (r.custom_hq) line.custom_hq = r.custom_hq
    if (r.custom_department) line.custom_department = r.custom_department
    return line
  })
}

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
  const [testLimit, setTestLimit] = useState('') // blank = all docs; e.g. "2" for a test run
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
      await db.erpIndex.where('sessionId').equals(session.id).delete()
      const RESOLVE_CHUNK = 200

      // 1) resolve Stockist → UAT Customer (the distributor link)
      const stockists = [...new Set(rows.map((r) => distributorOf(r.raw)).filter(Boolean))]
      const custMatch = new Map<string, CustomerMatch>()
      for (let i = 0; i < stockists.length; i += RESOLVE_CHUNK) {
        const slice = stockists.slice(i, i + RESOLVE_CHUNK)
        const body = await postJson('/api/erp/resolve-customers', { names: slice })
        for (const [k, v] of Object.entries((body.resolved || {}) as Record<string, CustomerMatch>)) custMatch.set(k, v)
        setBusy({ kind: 'resolve', done: Math.min(i + RESOLVE_CHUNK, stockists.length), total: stockists.length })
      }

      // 2) resolve Product → UAT Item
      const products = [...new Set(rows.map((r) => firstValue(r.raw, ['Product', 'Product Code'])).filter(Boolean))]
      const itemMatch = new Map<string, ItemMatch>()
      for (let i = 0; i < products.length; i += RESOLVE_CHUNK) {
        const slice = products.slice(i, i + RESOLVE_CHUNK)
        const body = await postJson('/api/erp/resolve-items', { names: slice })
        for (const [k, v] of Object.entries((body.resolved || {}) as Record<string, ItemMatch>)) itemMatch.set(k, v)
        setBusy({ kind: 'resolve', done: Math.min(i + RESOLVE_CHUNK, products.length), total: products.length })
      }

      // 3) look up existing docs by the RESOLVED customer + date (so an existing
      //    doc is detected even though the sheet spells the distributor loosely).
      const rawKeys = [...new Set(rows.map((r) => r.key).filter(Boolean))]
      const resToRaw = new Map<string, string>() // resolved lookup key → sheet key
      for (const rk of rawKeys) {
        const { distributor, date } = splitKey(rk)
        const cust = custMatch.get(distributor)
        resToRaw.set(`${cust?.name || distributor}${KEY_SEP}${date}`, rk)
      }
      const lookupKeys = [...resToRaw.keys()]
      const indexEntries: [string, ErpSummary][] = []
      for (let i = 0; i < lookupKeys.length; i += LOOKUP_CHUNK) {
        const slice = lookupKeys.slice(i, i + LOOKUP_CHUNK)
        const body = await postJson('/api/erp/lookup', { codes: slice })
        for (const rec of Object.values((body.records || {}) as Record<string, ErpSummary>)) {
          const rawKey = resToRaw.get(rec.code) || rec.code
          indexEntries.push([rawKey, { name: rec.name, code: rawKey, fields: rec.fields }])
          await db.erpIndex.bulkPut([{ sessionId: session.id, code: rawKey, name: rec.name, fields: rec.fields }])
        }
        setBusy({ kind: 'lookup', done: Math.min(i + LOOKUP_CHUNK, lookupKeys.length), total: lookupKeys.length })
      }

      // 4) triage + annotate item and distributor resolution
      setBusy({ kind: 'triage' })
      const results = await triageAll(rows.map((r) => ({ key: r.key, raw: r.raw })), indexEntries)
      const updated = rows.map((r, i) => {
        const prod = firstValue(r.raw, ['Product', 'Product Code'])
        const im = itemMatch.get(prod)
        // Region SKUs ("… AP") are intentionally left out — not a conflict.
        const itemStatus: 'ok' | 'ambiguous' | 'missing' | 'skip' = isSkippedProduct(prod) ? 'skip' : im?.status ?? 'missing'
        const cm = custMatch.get(distributorOf(r.raw))
        const distStatus: 'ok' | 'ambiguous' | 'missing' = r.key ? cm?.status ?? 'missing' : 'missing'
        // A row is a conflict (excluded from writes) if its item OR its
        // distributor can't be resolved, or it has no key. A 'skip' item is not
        // a conflict — it's just dropped from the doc's items.
        const itemBad = itemStatus !== 'ok' && itemStatus !== 'skip'
        const bad = results[i].action === 'conflict' || itemBad || distStatus !== 'ok'
        const action: TriageAction = bad ? 'conflict' : results[i].action
        return {
          ...r,
          action,
          erpName: results[i].erpName,
          changed: results[i].changed,
          resolvedItem: im?.name || '',
          itemStatus,
          itemOptions: im?.options,
          resolvedDistributor: cm?.name || '',
          distStatus,
          distOptions: cm?.options,
          runStatus: undefined,
          runError: undefined,
        }
      })

      // auto-map sales team (ERPNext "Apply Mapping"); date-scoped, non-blocking
      const mapGroups = new Map<string, { distributor: string; date: string; items: Set<string> }>()
      for (const r of updated) {
        if (r.action === 'conflict' || r.distStatus !== 'ok' || r.itemStatus !== 'ok' || !r.resolvedDistributor || !r.resolvedItem) continue
        const date = splitKey(r.key).date || dateOf(r.raw)
        const gk = `${r.resolvedDistributor}${KEY_SEP}${date}`
        const g = mapGroups.get(gk) ?? { distributor: r.resolvedDistributor, date, items: new Set<string>() }
        g.items.add(r.resolvedItem)
        mapGroups.set(gk, g)
      }
      const mapByGroup = new Map<string, MappingResult>()
      for (const [gk, g] of mapGroups) {
        const body = (await postJson('/api/erp/resolve-mapping', { distributor: g.distributor, date: g.date, items: [...g.items] })) as unknown as MappingResult
        mapByGroup.set(gk, body)
      }
      for (const r of updated) {
        if (r.action === 'conflict' || r.distStatus !== 'ok' || r.itemStatus !== 'ok' || !r.resolvedDistributor || !r.resolvedItem) continue
        const gm = mapByGroup.get(`${r.resolvedDistributor}${KEY_SEP}${splitKey(r.key).date || dateOf(r.raw)}`)
        const m = gm?.itemMap[r.resolvedItem]
        if (m) {
          r.custom_role_profile = m.custom_role_profile
          r.custom_hq = m.custom_hq
          r.custom_department = m.custom_department
          r.mapStatus = 'ok'
        } else if (gm && r.resolvedItem in gm.conflicts) {
          r.mapStatus = 'conflict'
          r.mapDepartments = gm.conflicts[r.resolvedItem]
        } else {
          r.mapStatus = 'unmapped'
        }
      }

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
  // Many sheet rows collapse into ONE parent doc (distributor + date). We write
  // per GROUP, then fan the result back onto every member row for display.
  const applyGroupResults = async (results: RowResult[], op: 'create' | 'update', byKey: Map<string, WriteGroup>) => {
    const touched: RowRec[] = []
    for (const res of results) {
      const group = byKey.get(res.key)
      if (!group) continue
      // On failure, print the doc + every item we sent (sheet → UAT) and the
      // ERP error to the console, so you can see exactly which item is rejected.
      if (!res.ok) {
        const { distributor, date } = splitKey(res.key)
        const cust = group.rows[0]?.resolvedDistributor || distributor
        // eslint-disable-next-line no-console
        console.error(`✗ ${op} failed — ${distributor} → ${cust} · ${date}\n${res.error}`)
        // eslint-disable-next-line no-console
        console.table(
          group.rows.map((r) => ({
            'Product (sheet)': firstValue(r.raw, ['Product', 'Product Code']),
            'Item → UAT': r.resolvedItem || '(unresolved)',
            status: r.itemStatus || '',
          })),
        )
      }
      for (const row of group.rows) {
        row.runOp = op
        row.runStatus = res.ok ? 'done' : 'error'
        row.runError = res.error
        row.runResultName = res.erpName
        touched.push(row)
      }
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
      // 'skip' rows (region SKUs) are dropped from the write — they never
      // become child items in the doc.
      const createRows = doCreate ? rows.filter((r) => r.action === 'create' && r.runStatus !== 'done' && r.itemStatus !== 'skip') : []
      const updateRows = doUpdate ? rows.filter((r) => r.action === 'update' && r.runStatus !== 'done' && r.itemStatus !== 'skip') : []
      // Test mode: cap how many DOCUMENTS (distributor+date groups) to write.
      const limit = Math.max(0, Math.floor(Number(testLimit) || 0))
      const cap = <T,>(arr: T[]) => (limit > 0 ? arr.slice(0, limit) : arr)
      const creates = cap(groupRows(createRows))
      const updates = cap(groupRows(updateRows))
      const total = creates.length + updates.length
      let base = 0
      const rec = { ...session, phase: 'running' as const, updatedAt: Date.now() }
      await getDb().sessions.put(rec)
      setSession(rec)

      if (creates.length > 0) {
        const byKey = new Map(creates.map((g) => [g.key, g]))
        setBusy({ kind: 'run', op: 'Creating', done: 0, total })
        await runInBatches({
          items: creates,
          batchSize: WRITE_BATCH,
          endpoint: '/api/erp/create',
          keyOf: (g) => g.key,
          buildBody: (slice) => ({
            rows: slice.map((g) => ({
              key: g.key,
              doc: { distributor: g.rows[0].resolvedDistributor || distributorOf(g.rows[0].raw), date: dateOf(g.rows[0].raw), items: groupItems(g.rows) },
            })),
          }),
          onResult: (res) => applyGroupResults(res, 'create', byKey),
          onProgress: (done) => setBusy({ kind: 'run', op: 'Creating', done: base + done, total }),
          signal: signal.current,
        })
        base += creates.length
      }
      if (updates.length > 0 && !signal.current.aborted) {
        const byKey = new Map(updates.map((g) => [g.key, g]))
        setBusy({ kind: 'run', op: 'Updating', done: base, total })
        await runInBatches({
          items: updates,
          batchSize: WRITE_BATCH,
          endpoint: '/api/erp/update',
          keyOf: (g) => g.key,
          buildBody: (slice) => ({
            rows: slice.map((g) => ({
              key: g.key,
              erpName: g.erpName,
              items: groupItems(g.rows),
            })),
          }),
          onResult: (res) => applyGroupResults(res, 'update', byKey),
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
      distributor: distributorOf(r.raw),
      distributorUat: r.resolvedDistributor || '',
      distStatus: r.distStatus || '',
      date: dateOf(r.raw),
      month: r.monthTag,
      file: r.fileName,
      productSheet: firstValue(r.raw, ['Product', 'Product Code']),
      itemUat: r.resolvedItem || '',
      itemStatus: r.itemStatus || '',
      roleProfile: r.custom_role_profile || '',
      hq: r.custom_hq || '',
      department: r.custom_department || '',
      mapStatus: r.mapStatus || '',
      action: r.action || '',
      erpRecord: r.runResultName || r.erpName || '',
      runStatus: r.runStatus || '',
      error: r.runError || '',
      ...r.raw,
    })
    // Everything that did NOT go through cleanly — conflicts + write failures —
    // in one sheet with a "problem" column, so it's easy to fix and re-run.
    const errorRows = rows
      .filter((r) => r.action === 'conflict' || r.runStatus === 'error')
      .map((r) => ({ problem: rowProblem(r), ...toRow(r) }))

    await exportXlsx(
      [
        { name: 'Errors', rows: errorRows },
        { name: 'All rows', rows: rows.map(toRow) },
        {
          name: 'Summary',
          rows: [
            { metric: 'Total rows', value: rows.length },
            { metric: 'Documents', value: docCount },
            ...(['create', 'update', 'unchanged', 'conflict'] as const).map((a) => ({ metric: `${a} (docs)`, value: counts[a] })),
            { metric: 'Conflict rows', value: rows.filter((r) => r.action === 'conflict').length },
            { metric: 'Docs written OK', value: counts.done },
            { metric: 'Docs with write errors', value: counts.failed },
          ],
        },
      ],
      `secondary-run-${session?.id || 'export'}.xlsx`,
    )
  }

  // ---- derived ----------------------------------------------------------------
  // Counts are per DOCUMENT (distinct distributor+date key), not per product
  // row — many product rows collapse into one Secondary Data Entry doc.
  const counts = useMemo(() => {
    const c = { create: 0, update: 0, unchanged: 0, conflict: 0, blocked: 0, done: 0, failed: 0 }
    const seenCreate = new Set<string>(), seenUpdate = new Set<string>(), seenUnchanged = new Set<string>()
    const seenDone = new Set<string>(), seenFailed = new Set<string>()
    const allKeys = new Set<string>() // every doc key seen (incl. conflict-only docs)
    for (const r of rows) {
      if (r.key) allKeys.add(r.key)
      if (r.action === 'conflict') { c.conflict++; continue } // rows that can't form a doc
      if (!r.key) continue
      if (r.action === 'create' && !seenCreate.has(r.key)) { seenCreate.add(r.key); c.create++ }
      else if (r.action === 'update' && !seenUpdate.has(r.key)) { seenUpdate.add(r.key); c.update++ }
      else if (r.action === 'unchanged' && !seenUnchanged.has(r.key)) { seenUnchanged.add(r.key); c.unchanged++ }
      if (r.runStatus === 'done' && !seenDone.has(r.key)) { seenDone.add(r.key); c.done++ }
      if (r.runStatus === 'error' && !seenFailed.has(r.key)) { seenFailed.add(r.key); c.failed++ }
    }
    // Blocked docs: a doc (distributor+date) with NO writable row — every line
    // is a conflict (e.g. distributor not found), so it can't be created.
    for (const k of allKeys) {
      if (!seenCreate.has(k) && !seenUpdate.has(k) && !seenUnchanged.has(k)) c.blocked++
    }
    return c
  }, [rows])

  // Number of distinct documents (distributor+date) across all loaded rows.
  const docCount = useMemo(() => new Set(rows.map((r) => r.key).filter(Boolean)).size, [rows])

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
    { key: 'distributor', header: 'Distributor (sheet)', width: 190, render: (r) => distributorOf(r.raw) || <span className="muted">—</span> },
    {
      key: 'distuat',
      header: 'Distributor → UAT',
      width: 190,
      render: (r) =>
        r.distStatus === 'ok' ? (
          <span className="mono" style={{ color: 'var(--green)' }}>{r.resolvedDistributor}</span>
        ) : r.distStatus === 'ambiguous' ? (
          <span className="pill amber" title={(r.distOptions || []).join(', ')}>ambiguous</span>
        ) : r.distStatus === 'missing' ? (
          <span className="pill error">not found</span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    { key: 'date', header: 'Date', width: 110, render: (r) => dateOf(r.raw) || <span className="muted">—</span> },
    { key: 'month', header: 'Month', width: 80, render: (r) => r.monthTag },
    { key: 'product', header: 'Product (sheet)', width: 200, render: (r) => firstValue(r.raw, ['Product', 'Product Code']) || <span className="muted">—</span> },
    {
      key: 'itemuat',
      header: 'Item → UAT',
      width: 200,
      render: (r) =>
        r.itemStatus === 'ok' ? (
          <span className="mono" style={{ color: 'var(--green)' }}>{r.resolvedItem}</span>
        ) : r.itemStatus === 'skip' ? (
          <span className="pill" title="Region SKU (… AP) — left out of the write">skipped</span>
        ) : r.itemStatus === 'ambiguous' ? (
          <span className="pill amber" title={(r.itemOptions || []).join(', ')}>ambiguous</span>
        ) : r.itemStatus === 'missing' ? (
          <span className="pill error">not found</span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    { key: 'action', header: 'Action', width: 110, render: (r) => (r.action ? <span className={`pill ${r.action}`}>{r.action}</span> : <span className="muted">—</span>) },
    {
      key: 'run',
      header: 'Run / issue',
      width: 260,
      render: (r) =>
        r.runStatus === 'done' ? (
          <span className="pill done">✓ {r.runOp}</span>
        ) : r.runStatus === 'error' ? (
          <span className="pill error" title={r.runError}>✗ {r.runError?.slice(0, 40)}</span>
        ) : r.action === 'conflict' ? (
          <span className="pill error" title={rowProblem(r)}>⚠ {rowProblem(r).slice(0, 44)}</span>
        ) : (
          <span className="muted">—</span>
        ),
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
              {rows.length.toLocaleString()} rows → {docCount.toLocaleString()} documents · {monthCounts.map(([m, n]) => `${m}: ${n.toLocaleString()}`).join(' · ')}
            </span>
          </h2>
          <div className="row-flex" style={{ marginBottom: 12 }}>
            <button className="primary" onClick={checkWithUat} disabled={isBusy || !health?.erp.configured}>
              Check with UAT {triaged ? '(re-run)' : ''}
            </button>
            {busy.kind === 'lookup' && (
              <>
                <div className="progress"><div style={{ width: `${(busy.done / busy.total) * 100}%` }} /></div>
                <span className="muted small">Looking up {busy.done.toLocaleString()}/{busy.total.toLocaleString()} docs…</span>
              </>
            )}
            {busy.kind === 'resolve' && (
              <>
                <div className="progress"><div style={{ width: `${(busy.done / Math.max(busy.total, 1)) * 100}%` }} /></div>
                <span className="muted small">Matching items {busy.done.toLocaleString()}/{busy.total.toLocaleString()}…</span>
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
                <div className="kpi green"><div className="label">Docs to create</div><div className="value">{counts.create.toLocaleString()}</div></div>
                <div className="kpi blue"><div className="label">Docs to update</div><div className="value">{counts.update.toLocaleString()}</div></div>
                <div className="kpi"><div className="label">Unchanged docs</div><div className="value">{counts.unchanged.toLocaleString()}</div></div>
                <div className="kpi amber" title={`${counts.conflict.toLocaleString()} conflict rows`}><div className="label">Can&apos;t create (docs)</div><div className="value">{counts.blocked.toLocaleString()}</div></div>
                <div className="kpi green"><div className="label">Docs written OK</div><div className="value">{counts.done.toLocaleString()}</div></div>
                <div className="kpi red"><div className="label">Docs with errors</div><div className="value">{counts.failed.toLocaleString()}</div></div>
              </div>

              <div className="row-flex" style={{ marginBottom: 12 }}>
                <label className="row-flex small"><input type="checkbox" checked={doCreate} onChange={(e) => setDoCreate(e.target.checked)} /> create {counts.create.toLocaleString()}</label>
                <label className="row-flex small"><input type="checkbox" checked={doUpdate} onChange={(e) => setDoUpdate(e.target.checked)} /> update {counts.update.toLocaleString()}</label>
                <label className="row-flex small" title="For a test run, write only the first N documents. Leave blank to do all.">
                  test:
                  <input
                    type="number"
                    min={1}
                    placeholder="all"
                    value={testLimit}
                    onChange={(e) => setTestLimit(e.target.value)}
                    style={{ width: 64, marginLeft: 4 }}
                  />
                  docs
                </label>
                <button className="primary" onClick={startRun} disabled={isBusy || (!doCreate && !doUpdate)}>
                  {Number(testLimit) > 0 ? `Run first ${Math.floor(Number(testLimit))} to UAT` : 'Run to UAT'}
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
          <h3 className="mono">{row.key ? `${splitKey(row.key).distributor} · ${splitKey(row.key).date}` : '(no key)'}</h3>
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
        {row.distStatus && row.distStatus !== 'ok' && (
          <div className="warn-box small">
            Distributor <span className="mono">{distributorOf(row.raw)}</span>{' '}
            {row.distStatus === 'missing' ? 'has no matching UAT customer' : 'is ambiguous'} — this doc is left out of the write.
            {(row.distOptions?.length ?? 0) > 0 && <> Candidates: {row.distOptions!.join(', ')}</>}
          </div>
        )}
        {row.distStatus === 'ok' && row.resolvedDistributor && (
          <p className="muted small">Distributor → UAT: <span className="mono" style={{ color: 'var(--green)' }}>{row.resolvedDistributor}</span></p>
        )}
        {row.itemStatus && row.itemStatus !== 'ok' && (
          <div className="warn-box small">
            Item <span className="mono">{firstValue(row.raw, ['Product', 'Product Code'])}</span>{' '}
            {row.itemStatus === 'missing' ? 'was not found in UAT' : 'is ambiguous (name truncated)'} — this line is left out of the write.
            {(row.itemOptions?.length ?? 0) > 0 && <> Candidates: {row.itemOptions!.join(', ')}</>}
          </div>
        )}
        {row.itemStatus === 'ok' && row.resolvedItem && (
          <p className="muted small">Item → UAT: <span className="mono" style={{ color: 'var(--green)' }}>{row.resolvedItem}</span></p>
        )}
        {row.mapStatus === 'ok' && (
          <p className="muted small">
            Sales team: <span className="mono" style={{ color: 'var(--green)' }}>{row.custom_role_profile}</span> · {row.custom_hq} · {row.custom_department}
          </p>
        )}
        {row.mapStatus === 'conflict' && (
          <div className="warn-box small">Sales-team mapping ambiguous — item sold by multiple departments: {(row.mapDepartments || []).join(', ')}</div>
        )}
        {row.mapStatus === 'unmapped' && (
          <p className="muted small">Sales team: no department match for this item + distributor (left blank).</p>
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
