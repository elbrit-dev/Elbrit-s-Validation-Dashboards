'use client'
// Validation — reads back what was actually created/updated in ERP for the
// customers in the loaded session, so the sheet run can be checked against the
// live UAT data. Table 1 (ERP DATA): every customer's item lines with the 5
// quantity/value figures and the auto-mapped sales team (department / role
// profile / HQ), exactly as posted in ERP.
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

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })
const mono = (v: string) => (v ? <span className="mono">{v}</span> : <span className="muted">—</span>)

export default function ValidationPage() {
  const [session, setSession] = useState<SessionRec | null>(null)
  const [rows, setRows] = useState<RowRec[]>([])
  const [loading, setLoading] = useState(true)
  const [erpRows, setErpRows] = useState<ErpLine[]>([])
  const [fetched, setFetched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')

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

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return erpRows
    return erpRows.filter((r) =>
      `${r.customer} ${r.item} ${r.custom_department} ${r.custom_role_profile} ${r.custom_hq}`.toLowerCase().includes(q),
    )
  }, [erpRows, search])

  // Distinct customers actually posted in ERP (for the "found" KPI).
  const erpCustomers = useMemo(() => new Set(erpRows.map((r) => r.customer)).size, [erpRows])

  const columns: VColumn<ErpLine>[] = [
    { key: 'customer', header: 'Customer', width: 240, render: (r) => r.customer || <span className="muted">—</span> },
    { key: 'item', header: 'Item', width: 200, render: (r) => mono(r.item) },
    { key: 'opening_qty', header: 'Op. Qty', width: 90, render: (r) => <span className="mono">{fmt(r.opening_qty)}</span> },
    { key: 'sales_qty', header: 'Sec. Qty', width: 90, render: (r) => <span className="mono">{fmt(r.sales_qty)}</span> },
    { key: 'sales_value', header: 'Sec. Value', width: 120, render: (r) => <span className="mono">{fmt(r.sales_value)}</span> },
    { key: 'closing_qty', header: 'Clos. Qty', width: 90, render: (r) => <span className="mono">{fmt(r.closing_qty)}</span> },
    { key: 'closing_balance', header: 'Clos. Value', width: 120, render: (r) => <span className="mono">{fmt(r.closing_balance)}</span> },
    { key: 'custom_department', header: 'Department', width: 170, render: (r) => r.custom_department || <span className="muted">—</span> },
    { key: 'custom_role_profile', header: 'Role Profile', width: 190, render: (r) => r.custom_role_profile || <span className="muted">—</span> },
    { key: 'custom_hq', header: 'HQ', width: 130, render: (r) => r.custom_hq || <span className="muted">—</span> },
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
      </div>

      <section className="panel">
        <div className="row-flex spread">
          <h2 style={{ margin: 0 }}>
            ERP DATA{' '}
            <span className="hint">
              {customers.length.toLocaleString()} customer(s) from this session, as posted in ERP — item lines with the 5 qty/value figures and the mapped sales team
            </span>
          </h2>
          <div className="row-flex" style={{ gap: 10 }}>
            {error && <span className="small" style={{ color: 'var(--red)' }}>{error}</span>}
            <button className="primary" onClick={loadErp} disabled={busy || customers.length === 0}>
              {busy ? 'Loading…' : fetched ? 'Refresh from ERP' : 'Load ERP data'}
            </button>
          </div>
        </div>
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
          empty={busy ? 'Loading ERP data…' : fetched ? 'No item lines posted in ERP for these customers.' : 'Click “Load ERP data”.'}
        />
      </section>
    </ErrorBoundary>
  )
}
