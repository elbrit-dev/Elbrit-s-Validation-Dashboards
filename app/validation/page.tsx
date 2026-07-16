'use client'
// Validation — reads back what was actually created/updated in ERP for the
// customers in the loaded session, so the sheet run can be checked against the
// live UAT data. Table 1 (ERP DATA): every customer's item lines with the 5
// quantity/value figures and the auto-mapped sales team (department / role
// profile / HQ), exactly as posted in ERP — with filters by customer and by the
// lines whose sales-team mapping is missing.
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import ErrorBoundary from '@/components/ErrorBoundary'
import VirtualTable, { type VColumn } from '@/components/VirtualTable'
import { getDb, latestSession, type RowRec, type SessionRec } from '@/lib/client/db'
import { dateOf } from '@/lib/shared/mapping'

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
  // Filters: a set of selected customers (empty = all) and a set of active
  // "missing field" toggles (empty = don't filter on missing).
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

  // The customers to validate: every stockist that resolved to a UAT customer.
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

  // Auto-load once, as soon as the resolved customers are known.
  useEffect(() => {
    if (customers.length && !fetched && !busy) loadErp()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customers])

  const searchPred = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (r: ErpLine) =>
      !q || `${r.customer} ${r.item} ${r.custom_department} ${r.custom_role_profile} ${r.custom_hq}`.toLowerCase().includes(q)
  }, [search])

  // Lines after the search box only — the base for the per-customer counts.
  const searched = useMemo(() => erpRows.filter(searchPred), [erpRows, searchPred])

  // Customer → line count (over the searched set), for the customer filter chips.
  const custCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of searched) m.set(r.customer, (m.get(r.customer) || 0) + 1)
    return m
  }, [searched])

  // Apply the customer filter (empty selection = all).
  const afterCust = useMemo(
    () => (selCustomers.size ? searched.filter((r) => selCustomers.has(r.customer)) : searched),
    [searched, selCustomers],
  )

  // Missing-field counts over the customer-filtered set (what the chips report).
  const missCounts = useMemo(() => {
    const c: Record<MissKey, number> = { custom_department: 0, custom_role_profile: 0, custom_hq: 0 }
    for (const r of afterCust) for (const m of MISS) if (!r[m.key]) c[m.key]++
    return c
  }, [afterCust])
  const missingTotal = useMemo(() => afterCust.filter((r) => !r.custom_department || !r.custom_role_profile || !r.custom_hq).length, [afterCust])

  // Final visible rows: customer-filtered, then narrowed to lines missing ANY of
  // the active missing-field toggles.
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
    {
      key: 'custom_department',
      header: 'Department',
      width: 180,
      render: (r) => (r.custom_department ? r.custom_department : <span className="pill warning">missing</span>),
    },
    {
      key: 'custom_role_profile',
      header: 'Role Profile',
      width: 190,
      render: (r) => (r.custom_role_profile ? <span className="mono">{r.custom_role_profile}</span> : <span className="pill warning">missing</span>),
    },
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
        <div className="kpi">
          <div className="label">Customers (sheet)</div>
          <div className="value">{customers.length.toLocaleString()}</div>
        </div>
        <div className="kpi green">
          <div className="label">Customers found in ERP</div>
          <div className="value">{fetched ? erpCustomers.toLocaleString() : '—'}</div>
        </div>
        <div className="kpi blue">
          <div className="label">ERP item lines</div>
          <div className="value">{fetched ? erpRows.length.toLocaleString() : '—'}</div>
        </div>
        <div className="kpi amber">
          <div className="label">Lines missing sales team</div>
          <div className="value">{fetched ? missingTotal.toLocaleString() : '—'}</div>
        </div>
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

        {/* Warning if any line has no sales team mapped */}
        {fetched && missingTotal > 0 && (
          <div className="warn-box small" style={{ marginTop: 10 }}>
            ⚠ {missingTotal.toLocaleString()} item line{missingTotal === 1 ? '' : 's'} have no sales team mapped in ERP (Department / Role Profile / HQ).
            Use the warning chips below to see them.
          </div>
        )}

        {/* Missing-field warning filters */}
        <div className="fbar" style={{ marginTop: 12 }}>
          <span className="muted small" style={{ marginRight: 2 }}>Missing in ERP:</span>
          {MISS.map((m) => {
            const n = missCounts[m.key]
            return (
              <button
                key={m.key}
                className={`fchip warn ${missOn.has(m.key) ? 'on' : ''} ${n === 0 ? 'zero' : ''}`}
                onClick={() => toggleMiss(m.key)}
                title={n === 0 ? 'None missing this field' : `${n} line(s) with no ${m.label.replace('Missing ', '')}`}
              >
                {m.label} <span className="cnt">{n}</span>
              </button>
            )
          })}
          {missOn.size > 0 && (
            <button className="linklike small" onClick={() => setMissOn(new Set())}>clear</button>
          )}
        </div>

        {/* Customer filter */}
        <div className="fbar" style={{ marginTop: 10 }}>
          <span className="muted small" style={{ marginRight: 2 }}>Customers:</span>
          <button className={`fchip ${selCustomers.size === 0 ? 'on' : ''}`} onClick={() => setSelCustomers(new Set())}>
            All <span className="cnt">{custCounts.size}</span>
          </button>
          <button className="linklike small" onClick={() => setShowCustomers((v) => !v)}>
            {showCustomers ? 'hide list' : selCustomers.size ? `${selCustomers.size} selected — edit` : 'pick customers'}
          </button>
          {selCustomers.size > 0 && (
            <button className="linklike small" onClick={() => setSelCustomers(new Set())}>clear</button>
          )}
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
          <input
            type="text"
            placeholder="Search customer / item / department / role profile / HQ…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ flex: 1, minWidth: 240 }}
          />
          <span className="muted small">
            {visible.length.toLocaleString()} of {erpRows.length.toLocaleString()} lines
          </span>
        </div>
        <VirtualTable
          rows={visible}
          columns={columns}
          height={620}
          empty={busy ? 'Loading ERP data…' : fetched ? 'No item lines match the current filters.' : 'Click “Load ERP data”.'}
        />
      </section>
    </ErrorBoundary>
  )
}
