'use client'
// Validation against the live ERP data.
//   Table 1 — ERP DATA: the session's customers as posted in ERP (item lines
//     with the 5 qty/value figures + the auto-mapped department / role / HQ).
//   Table 2 — SHEET ↔ ERP: every sheet line compared field-by-field against
//     that ERP data — customer matched, item present, each qty/value, department
//     missing, and sheet State vs the department's state.
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import ErrorBoundary from '@/components/ErrorBoundary'
import VirtualTable, { type VColumn } from '@/components/VirtualTable'
import { getDb, latestSession, type RowRec, type SessionRec } from '@/lib/client/db'
import { dateOf, distributorOf, firstValue, CHILD_FIELDS } from '@/lib/shared/mapping'
import { parseNum } from '@/lib/shared/normalize'

interface ErpLine {
  customer: string
  date: string
  item: string
  opening_qty: number
  sales_qty: number
  sales_value: number
  closing_qty: number
  closing_balance: number
  custom_role_profile: string
  custom_hq: string
  custom_department: string
}

// The sales-team fields we flag when blank on an ERP line.
type MissKey = 'custom_department' | 'custom_role_profile' | 'custom_hq'
const MISS: { key: MissKey; label: string }[] = [
  { key: 'custom_department', label: 'Missing Department' },
  { key: 'custom_role_profile', label: 'Missing Role Profile' },
  { key: 'custom_hq', label: 'Missing HQ' },
]

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })
const mono = (v: string) => (v ? <span className="mono">{v}</span> : <span className="muted">—</span>)
const orDash = (v: string) => (v ? v : <span className="muted">—</span>)

export default function ValidationPage() {
  const [session, setSession] = useState<SessionRec | null>(null)
  const [rows, setRows] = useState<RowRec[]>([])
  const [loading, setLoading] = useState(true)
  const [erpRows, setErpRows] = useState<ErpLine[]>([])
  const [fetched, setFetched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [selCustomers, setSelCustomers] = useState<Set<string>>(new Set())
  const [missOn, setMissOn] = useState<Set<MissKey>>(new Set())
  const [showCustomers, setShowCustomers] = useState(false)

  useEffect(() => {
    ;(async () => {
      const s = await latestSession()
      if (!s) {
        setLoading(false)
        return
      }
      setSession(s)
      const rs = await getDb().rows.where('sessionId').equals(s.id).toArray()
      rs.sort((a, b) => (a.rid || 0) - (b.rid || 0))
      setRows(rs)
      setLoading(false)
    })()
  }, [])

  const customers = useMemo(
    () => [...new Set(rows.filter((r) => r.distStatus === 'ok' && r.resolvedDistributor).map((r) => r.resolvedDistributor as string))].sort(),
    [rows],
  )

  const loadErp = useMemo(
    () => async () => {
      if (customers.length === 0) return
      setBusy(true)
      setError('')
      try {
        const dates = rows.map((r) => dateOf(r.raw)).filter(Boolean).sort()
        const from = dates[0]
        const to = dates[dates.length - 1]
        const res = await fetch('/api/erp/secondary-lines', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customers, from, to }),
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error((body.detail as string) || (body.error as string) || `HTTP ${res.status}`)
        setErpRows((body.rows as ErpLine[]) || [])
        setFetched(true)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [customers, rows],
  )

  useEffect(() => {
    if (customers.length && !fetched && !busy) loadErp()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customers])

  // ---- ERP DATA table (table 1) --------------------------------------------
  const searchPred = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (r: ErpLine) =>
      !q || `${r.customer} ${r.item} ${r.custom_department} ${r.custom_role_profile} ${r.custom_hq}`.toLowerCase().includes(q)
  }, [search])
  const searched = useMemo(() => erpRows.filter(searchPred), [erpRows, searchPred])
  const custCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of searched) m.set(r.customer, (m.get(r.customer) || 0) + 1)
    return m
  }, [searched])
  const afterCust = useMemo(
    () => (selCustomers.size ? searched.filter((r) => selCustomers.has(r.customer)) : searched),
    [searched, selCustomers],
  )
  const missCounts = useMemo(() => {
    const c: Record<MissKey, number> = { custom_department: 0, custom_role_profile: 0, custom_hq: 0 }
    for (const r of afterCust) for (const m of MISS) if (!r[m.key]) c[m.key]++
    return c
  }, [afterCust])
  const missingTotal = useMemo(() => afterCust.filter((r) => !r.custom_department || !r.custom_role_profile || !r.custom_hq).length, [afterCust])
  const visible = useMemo(() => {
    if (missOn.size === 0) return afterCust
    return afterCust.filter((r) => [...missOn].some((k) => !r[k]))
  }, [afterCust, missOn])
  const erpCustomers = useMemo(() => new Set(erpRows.map((r) => r.customer)).size, [erpRows])

  const toggleCustomer = (c: string) =>
    setSelCustomers((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })
  const toggleMiss = (k: MissKey) =>
    setMissOn((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })

  const columns: VColumn<ErpLine>[] = [
    { key: 'customer', header: 'Customer', width: 240, render: (r) => orDash(r.customer) },
    { key: 'item', header: 'Item', width: 200, render: (r) => mono(r.item) },
    { key: 'opening_qty', header: 'Op. Qty', width: 90, render: (r) => <span className="mono">{fmt(r.opening_qty)}</span> },
    { key: 'sales_qty', header: 'Sec. Qty', width: 90, render: (r) => <span className="mono">{fmt(r.sales_qty)}</span> },
    { key: 'sales_value', header: 'Sec. Value', width: 120, render: (r) => <span className="mono">{fmt(r.sales_value)}</span> },
    { key: 'closing_qty', header: 'Clos. Qty', width: 90, render: (r) => <span className="mono">{fmt(r.closing_qty)}</span> },
    { key: 'closing_balance', header: 'Clos. Value', width: 120, render: (r) => <span className="mono">{fmt(r.closing_balance)}</span> },
    { key: 'custom_department', header: 'Department', width: 180, render: (r) => (r.custom_department ? r.custom_department : <span className="pill warning">missing</span>) },
    { key: 'custom_role_profile', header: 'Role Profile', width: 190, render: (r) => (r.custom_role_profile ? <span className="mono">{r.custom_role_profile}</span> : <span className="pill warning">missing</span>) },
    { key: 'custom_hq', header: 'HQ', width: 150, render: (r) => (r.custom_hq ? r.custom_hq : <span className="pill warning">missing</span>) },
  ]

  if (loading) return <p className="muted">Loading session…</p>
  if (!session || rows.length === 0)
    return (
      <div className="panel">
        <p className="muted">No session loaded yet.</p>
        <Link href="/entry">
          <button className="primary">Go to Entry and load sheets</button>
        </Link>
      </div>
    )

  return (
    <ErrorBoundary>
      <div className="kpis">
        <div className="kpi"><div className="label">Customers (sheet)</div><div className="value">{customers.length.toLocaleString()}</div></div>
        <div className="kpi green"><div className="label">Customers found in ERP</div><div className="value">{fetched ? erpCustomers.toLocaleString() : '—'}</div></div>
        <div className="kpi blue"><div className="label">ERP item lines</div><div className="value">{fetched ? erpRows.length.toLocaleString() : '—'}</div></div>
        <div className="kpi amber"><div className="label">Lines missing sales team</div><div className="value">{fetched ? missingTotal.toLocaleString() : '—'}</div></div>
      </div>

      <section className="panel">
        <div className="row-flex spread">
          <h2 style={{ margin: 0 }}>
            ERP DATA <span className="hint">{customers.length.toLocaleString()} customer(s) from this session, as posted in ERP</span>
          </h2>
          <div className="row-flex" style={{ gap: 10 }}>
            {error && <span className="small" style={{ color: 'var(--red)' }}>{error}</span>}
            <button className="primary" onClick={loadErp} disabled={busy || customers.length === 0}>
              {busy ? 'Loading…' : fetched ? 'Refresh from ERP' : 'Load ERP data'}
            </button>
          </div>
        </div>

        {fetched && missingTotal > 0 && (
          <div className="warn-box small" style={{ marginTop: 10 }}>
            ⚠ {missingTotal.toLocaleString()} item line{missingTotal === 1 ? '' : 's'} have no sales team mapped in ERP (Department / Role Profile / HQ). Use the chips below to see them.
          </div>
        )}

        <div className="fbar" style={{ marginTop: 12 }}>
          <span className="muted small" style={{ marginRight: 2 }}>Missing in ERP:</span>
          {MISS.map((m) => {
            const n = missCounts[m.key]
            return (
              <button key={m.key} className={`fchip warn ${missOn.has(m.key) ? 'on' : ''} ${n === 0 ? 'zero' : ''}`} onClick={() => toggleMiss(m.key)}>
                {m.label} <span className="cnt">{n}</span>
              </button>
            )
          })}
          {missOn.size > 0 && <button className="linklike small" onClick={() => setMissOn(new Set())}>clear</button>}
        </div>

        <div className="fbar" style={{ marginTop: 10 }}>
          <span className="muted small" style={{ marginRight: 2 }}>Customers:</span>
          <button className={`fchip ${selCustomers.size === 0 ? 'on' : ''}`} onClick={() => setSelCustomers(new Set())}>All <span className="cnt">{custCounts.size}</span></button>
          <button className="linklike small" onClick={() => setShowCustomers((v) => !v)}>
            {showCustomers ? 'hide list' : selCustomers.size ? `${selCustomers.size} selected — edit` : 'pick customers'}
          </button>
          {selCustomers.size > 0 && <button className="linklike small" onClick={() => setSelCustomers(new Set())}>clear</button>}
        </div>
        {showCustomers && (
          <div className="fbar" style={{ marginTop: 8, maxHeight: 150, overflow: 'auto', padding: 8, border: '1px solid var(--border)', borderRadius: 8 }}>
            {[...custCounts.keys()].sort().map((c) => (
              <button key={c} className={`fchip ${selCustomers.has(c) ? 'on' : ''}`} onClick={() => toggleCustomer(c)}>
                {c} <span className="cnt">{custCounts.get(c)}</span>
              </button>
            ))}
            {custCounts.size === 0 && <span className="muted small">No customers to show.</span>}
          </div>
        )}

        <div className="row-flex" style={{ margin: '12px 0' }}>
          <input type="text" placeholder="Search customer / item / department / role profile / HQ…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 240 }} />
          <span className="muted small">{visible.length.toLocaleString()} of {erpRows.length.toLocaleString()} lines</span>
        </div>
        <VirtualTable rows={visible} columns={columns} height={520} empty={busy ? 'Loading ERP data…' : fetched ? 'No item lines match the current filters.' : 'Click “Load ERP data”.'} />
      </section>

      <SheetErpCompare rows={rows} erpRows={erpRows} fetched={fetched} />
    </ErrorBoundary>
  )
}

// ============================================================================
// Table 2 — SHEET ↔ ERP comparison
// ============================================================================

type NumKey = 'opening_qty' | 'sales_qty' | 'sales_value' | 'closing_qty' | 'closing_balance'
const NUM_FIELDS: { key: NumKey; label: string }[] = [
  { key: 'opening_qty', label: 'Op. Qty' },
  { key: 'sales_qty', label: 'Sec. Qty' },
  { key: 'sales_value', label: 'Sec. Value' },
  { key: 'closing_qty', label: 'Clos. Qty' },
  { key: 'closing_balance', label: 'Clos. Value' },
]
const zeroNums = (): Record<NumKey, number> => ({ opening_qty: 0, sales_qty: 0, sales_value: 0, closing_qty: 0, closing_balance: 0 })
const childHeaders = (key: string) => CHILD_FIELDS.find((f) => f.key === key)?.sheet ?? []
const sheetNum = (raw: Record<string, unknown>, key: NumKey) => parseNum(firstValue(raw, childHeaders(key)))
const round2 = (n: number) => Math.round(n * 100) / 100
const near = (a: number, b: number) => Math.abs(round2(a) - round2(b)) < 0.01
const CMP_SEP = '␟'

// Which state a label belongs to (sheet State column OR a department name).
const STATE_ALIASES: [string, RegExp][] = [
  ['TELANGANA', /TELANGANA|TELENGANA|\bTG\b/],
  ['ANDHRA', /ANDHRA|\bAP\b/],
]
const stateToken = (s: string): string => {
  const up = (s || '').toUpperCase()
  for (const [canon, re] of STATE_ALIASES) if (re.test(up)) return canon
  return ''
}

interface Cmp {
  customer: string
  item: string
  customerOk: boolean
  itemResolved: boolean
  inErp: boolean
  itemOk: boolean // customer matched, item resolved AND present in ERP
  sheet: Record<NumKey, number>
  erp: Record<NumKey, number> | null
  numOff: Record<NumKey, boolean>
  department: string
  deptMissing: boolean
  sheetState: string
  deptState: string
  stateOff: boolean
  issues: string[] // category keys: 'customer' | 'item' | NumKey | 'department' | 'state'
}

function buildCompares(rows: RowRec[], erpRows: ErpLine[]): Cmp[] {
  // ERP totals per (customer, item).
  const erpAgg = new Map<string, { nums: Record<NumKey, number>; department: string }>()
  for (const e of erpRows) {
    const k = `${e.customer}${CMP_SEP}${e.item}`
    let a = erpAgg.get(k)
    if (!a) {
      a = { nums: zeroNums(), department: '' }
      erpAgg.set(k, a)
    }
    for (const f of NUM_FIELDS) a.nums[f.key] += e[f.key]
    if (!a.department && e.custom_department) a.department = e.custom_department
  }

  // Sheet totals per displayed (customer, item). 'skip' region SKUs are left out
  // (they are intentionally never written to ERP).
  interface SAgg { customer: string; item: string; customerOk: boolean; itemResolved: boolean; erpKey: string; nums: Record<NumKey, number>; state: string }
  const sAgg = new Map<string, SAgg>()
  for (const r of rows) {
    if (r.itemStatus === 'skip') continue
    const customerOk = r.distStatus === 'ok' && !!r.resolvedDistributor
    const itemResolved = r.itemStatus === 'ok' && !!r.resolvedItem
    const customer = r.resolvedDistributor || distributorOf(r.raw) || '(no customer)'
    const item = r.resolvedItem || firstValue(r.raw, ['Product', 'Product Code']) || '(no item)'
    const dispKey = `${customer}${CMP_SEP}${item}`
    let a = sAgg.get(dispKey)
    if (!a) {
      a = {
        customer,
        item,
        customerOk,
        itemResolved,
        erpKey: customerOk && itemResolved ? `${r.resolvedDistributor}${CMP_SEP}${r.resolvedItem}` : '',
        nums: zeroNums(),
        state: firstValue(r.raw, ['State']),
      }
      sAgg.set(dispKey, a)
    }
    for (const f of NUM_FIELDS) a.nums[f.key] += sheetNum(r.raw, f.key)
    if (!a.state) a.state = firstValue(r.raw, ['State'])
  }

  const out: Cmp[] = []
  for (const s of sAgg.values()) {
    const erp = s.erpKey ? erpAgg.get(s.erpKey) : undefined
    const inErp = !!erp
    const itemOk = s.customerOk && s.itemResolved && inErp
    const numOff = { opening_qty: false, sales_qty: false, sales_value: false, closing_qty: false, closing_balance: false } as Record<NumKey, boolean>
    if (itemOk && erp) for (const f of NUM_FIELDS) numOff[f.key] = !near(s.nums[f.key], erp.nums[f.key])
    const department = erp?.department || ''
    const deptMissing = itemOk ? !department : false
    const deptState = stateToken(department)
    const sheetST = stateToken(s.state)
    const stateOff = itemOk && !!department && !!deptState && !!sheetST && deptState !== sheetST
    const issues: string[] = []
    if (!s.customerOk) issues.push('customer')
    else if (!itemOk) issues.push('item')
    else {
      for (const f of NUM_FIELDS) if (numOff[f.key]) issues.push(f.key)
      if (deptMissing) issues.push('department')
      if (stateOff) issues.push('state')
    }
    out.push({
      customer: s.customer,
      item: s.item,
      customerOk: s.customerOk,
      itemResolved: s.itemResolved,
      inErp,
      itemOk,
      sheet: s.nums,
      erp: erp ? erp.nums : null,
      numOff,
      department,
      deptMissing,
      sheetState: s.state,
      deptState,
      stateOff,
      issues,
    })
  }
  out.sort((a, b) => (b.issues.length > 0 ? 1 : 0) - (a.issues.length > 0 ? 1 : 0) || a.customer.localeCompare(b.customer) || a.item.localeCompare(b.item))
  return out
}

// The field chips shown in "mismatches by field".
const CHIP_FIELDS: { key: string; label: string }[] = [
  { key: 'customer', label: 'Customer' },
  { key: 'item', label: 'Item' },
  ...NUM_FIELDS.map((f) => ({ key: f.key, label: f.label })),
  { key: 'department', label: 'Department' },
  { key: 'state', label: 'State ↔ Dept' },
]

function CmpNumCell({ ok, off, sheet, erp }: { ok: boolean; off: boolean; sheet: number; erp: number }) {
  if (!ok) return <span className="muted">—</span>
  if (!off) return <span style={{ color: 'var(--green)' }}>✓</span>
  return (
    <span className="mono" style={{ color: 'var(--red)' }} title={`sheet ${fmt(sheet)} → ERP ${fmt(erp)}`}>
      {fmt(sheet)}→{fmt(erp)}
    </span>
  )
}

function SheetErpCompare({ rows, erpRows, fetched }: { rows: RowRec[]; erpRows: ErpLine[]; fetched: boolean }) {
  const [tab, setTab] = useState<'issues' | 'clean' | 'all'>('issues')
  const [fieldOn, setFieldOn] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')

  const cmps = useMemo(() => (fetched ? buildCompares(rows, erpRows) : []), [rows, erpRows, fetched])

  const searched = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return cmps
    return cmps.filter((c) => `${c.customer} ${c.item} ${c.department} ${c.sheetState}`.toLowerCase().includes(q))
  }, [cmps, search])

  // Field-mismatch counts over the searched set (drive the chips).
  const fieldCounts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const f of CHIP_FIELDS) m[f.key] = 0
    for (const c of searched) for (const k of c.issues) if (k in m) m[k]++
    return m
  }, [searched])

  const stats = useMemo(() => {
    let clean = 0
    let issues = 0
    let itemOrCust = 0
    let numOff = 0
    let dept = 0
    let state = 0
    for (const c of searched) {
      if (c.issues.length === 0) clean++
      else issues++
      if (c.issues.includes('customer') || c.issues.includes('item')) itemOrCust++
      if (NUM_FIELDS.some((f) => c.numOff[f.key])) numOff++
      if (c.deptMissing) dept++
      if (c.stateOff) state++
    }
    return { total: searched.length, clean, issues, itemOrCust, numOff, dept, state }
  }, [searched])

  const visible = useMemo(() => {
    let list = searched
    if (tab === 'issues') list = list.filter((c) => c.issues.length > 0)
    else if (tab === 'clean') list = list.filter((c) => c.issues.length === 0)
    if (fieldOn.size) list = list.filter((c) => c.issues.some((k) => fieldOn.has(k)))
    return list
  }, [searched, tab, fieldOn])

  const toggleField = (k: string) =>
    setFieldOn((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })

  const columns: VColumn<Cmp>[] = [
    {
      key: 'customer',
      header: 'Customer (sheet)',
      width: 230,
      render: (c) => (c.customerOk ? c.customer : <span style={{ color: 'var(--red)' }} title="Stockist did not match a UAT customer">{c.customer} · not matched</span>),
    },
    {
      key: 'item',
      header: 'Item',
      width: 200,
      render: (c) => {
        if (!c.customerOk) return <span className="muted">—</span>
        if (c.itemOk) return <span className="mono">{c.item}</span>
        return (
          <span className="mono" style={{ color: 'var(--red)' }} title={c.itemResolved ? 'Resolved but not found in ERP' : 'Item did not match a UAT item'}>
            {c.item} · {c.itemResolved ? 'not in ERP' : 'not matched'}
          </span>
        )
      },
    },
    ...NUM_FIELDS.map(
      (f): VColumn<Cmp> => ({
        key: f.key,
        header: f.label,
        width: 120,
        render: (c) => <CmpNumCell ok={c.itemOk} off={c.numOff[f.key]} sheet={c.sheet[f.key]} erp={c.erp ? c.erp[f.key] : 0} />,
      }),
    ),
    {
      key: 'department',
      header: 'Department',
      width: 180,
      render: (c) => (!c.itemOk ? <span className="muted">—</span> : c.deptMissing ? <span className="pill warning">missing</span> : c.department),
    },
    {
      key: 'state',
      header: 'State ↔ Dept',
      width: 150,
      render: (c) => {
        if (!c.itemOk) return <span className="muted">—</span>
        if (c.stateOff) return <span style={{ color: 'var(--red)' }} title={`sheet ${c.sheetState} vs department ${c.department}`}>✗ {c.sheetState || '?'}≠{c.deptState}</span>
        if (c.deptState) return <span style={{ color: 'var(--green)' }}>✓ {c.deptState}</span>
        return <span className="muted">—</span>
      },
    },
  ]

  return (
    <section className="panel">
      <h2 style={{ marginTop: 0 }}>
        SHEET ↔ ERP <span className="hint">each sheet line compared field-by-field against the ERP data above</span>
      </h2>

      {!fetched ? (
        <p className="muted">Load the ERP data above first — this compares every sheet line against it.</p>
      ) : (
        <>
          <div className="kpis" style={{ marginBottom: 14 }}>
            <div className="kpi"><div className="label">Sheet lines</div><div className="value">{stats.total.toLocaleString()}</div></div>
            <div className="kpi green"><div className="label">Clean (all match)</div><div className="value">{stats.clean.toLocaleString()}</div></div>
            <div className="kpi amber"><div className="label">With issues</div><div className="value">{stats.issues.toLocaleString()}</div></div>
            <div className="kpi red"><div className="label">Item / customer missing</div><div className="value">{stats.itemOrCust.toLocaleString()}</div></div>
            <div className="kpi red"><div className="label">Qty / value mismatch</div><div className="value">{stats.numOff.toLocaleString()}</div></div>
            <div className="kpi amber"><div className="label">Department missing</div><div className="value">{stats.dept.toLocaleString()}</div></div>
            <div className="kpi red"><div className="label">State mismatch</div><div className="value">{stats.state.toLocaleString()}</div></div>
          </div>

          <div className="fbar" style={{ marginBottom: 10 }}>
            <span className="muted small" style={{ marginRight: 2 }}>Mismatches by field:</span>
            {CHIP_FIELDS.map((f) => {
              const n = fieldCounts[f.key]
              return (
                <button key={f.key} className={`fchip warn ${fieldOn.has(f.key) ? 'on' : ''} ${n === 0 ? 'zero' : ''}`} onClick={() => toggleField(f.key)}>
                  {f.label} <span className="cnt">{n}</span>
                </button>
              )
            })}
            {fieldOn.size > 0 && <button className="linklike small" onClick={() => setFieldOn(new Set())}>clear</button>}
          </div>

          <div className="row-flex" style={{ marginBottom: 12 }}>
            <div className="tabs">
              {(['issues', 'clean', 'all'] as const).map((t) => (
                <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                  {t === 'issues' ? `Issues (${stats.issues})` : t === 'clean' ? `Clean (${stats.clean})` : `All (${stats.total})`}
                </button>
              ))}
            </div>
            <input type="text" placeholder="Search customer / item / department…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
            <span className="muted small">{visible.length.toLocaleString()} shown</span>
          </div>

          <VirtualTable rows={visible} columns={columns} height={560} empty="No lines match the current filters." />
        </>
      )}
    </section>
  )
}
