'use client'
// EBS Validation — a per-CUSTOMER view of the loaded session. Instead of the
// row-by-row rule dashboard (/validation), this groups every sheet row by its
// resolved UAT customer (pinned via the EBS Stockist Code, with the alias/name
// fallback) and shows the sheet totals + the sales team(s) that the lines map
// to. The point: when one customer's lines span MULTIPLE sales teams you can
// see and check that here, without downloading the sheet and filtering by hand.
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import ErrorBoundary from '@/components/ErrorBoundary'
import VirtualTable, { type VColumn } from '@/components/VirtualTable'
import { getDb, latestSession, type RowRec, type SessionRec } from '@/lib/client/db'
import { numOf } from '@/lib/validation/rules'
import { distributorOf, distributorCodeOf, dateOf, firstValue } from '@/lib/shared/mapping'

const QTY_KEYS = [
  ['opening_qty', 'Op. Qty'],
  ['sales_qty', 'Sec. Qty'],
  ['sales_value', 'Sec. Value'],
  ['closing_qty', 'Clos. Qty'],
  ['closing_balance', 'Clos. Value'],
] as const

type QtyKey = (typeof QTY_KEYS)[number][0]
type Totals = Record<QtyKey, number>
const zero = (): Totals => ({ opening_qty: 0, sales_qty: 0, sales_value: 0, closing_qty: 0, closing_balance: 0 })
const addRow = (acc: Totals, row: RowRec) => {
  for (const [k] of QTY_KEYS) acc[k] += numOf(row.raw, k)
}
const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })
// Sheet figure alongside the ERP-posted figure. `shown` gates the ERP side (only
// after a comparison, and only for a resolved customer); `erp === undefined` after
// that means the customer resolved but has nothing posted in ERP for this range.
const near = (a: number, b: number) => Math.abs(a - b) < 0.005
function NumPair({ sheet, erp, shown }: { sheet: number; erp: number | undefined; shown: boolean }) {
  if (!shown) return <span className="mono">{fmt(sheet)}</span>
  if (erp === undefined)
    return (
      <span className="mono">
        {fmt(sheet)} <span className="muted"> → n/a</span>
      </span>
    )
  const ok = near(sheet, erp)
  return (
    <span className="mono">
      {fmt(sheet)}
      <span style={{ color: ok ? 'var(--green)' : 'var(--red)' }}> → {fmt(erp)}</span>
    </span>
  )
}

// One sales team (role profile) within a customer, with its own line subtotal.
interface Team {
  name: string // custom_role_profile — the sales team; '(unmapped)' when blank
  hq: string
  department: string
  rows: RowRec[]
  totals: Totals
}

interface EbsGroup {
  id: string
  customer: string // resolved UAT customer, else the EBS code / sheet name
  status: 'ok' | 'ambiguous' | 'missing' | 'unchecked'
  ebsCodes: string[] // the sheet's Stockist Code(s) for this customer
  erpEbs: string[] // the resolved UAT customer's ERP EBS codes (both columns)
  ebsMatch: 'ok' | 'mismatch' | 'na' // does the sheet EBS match one of the ERP columns?
  sheetNames: string[]
  hqs: string[]
  dates: string[]
  rows: RowRec[]
  teams: Team[]
  totals: Totals
  itemCount: number
  multiTeam: boolean // lines map to more than one sales team
}

const uniq = (xs: string[]) => [...new Set(xs.filter((x) => x && x.trim() !== ''))]

function buildGroups(rows: RowRec[]): EbsGroup[] {
  const byCust = new Map<string, RowRec[]>()
  for (const r of rows) {
    // Group by the resolved customer when we have it; otherwise by the EBS code
    // (so unresolved look-alikes still separate), else the raw stockist name.
    const key = r.resolvedDistributor || distributorCodeOf(r.raw) || distributorOf(r.raw) || '(no distributor)'
    const arr = byCust.get(key)
    if (arr) arr.push(r)
    else byCust.set(key, [r])
  }

  const groups: EbsGroup[] = []
  for (const [key, rs] of byCust) {
    const totals = zero()
    const teamsMap = new Map<string, Team>()
    for (const r of rs) {
      addRow(totals, r)
      const teamName = r.custom_role_profile || '(unmapped)'
      const t = teamsMap.get(teamName) ?? { name: teamName, hq: r.custom_hq || '', department: r.custom_department || '', rows: [], totals: zero() }
      t.rows.push(r)
      addRow(t.totals, r)
      if (!t.hq && r.custom_hq) t.hq = r.custom_hq
      if (!t.department && r.custom_department) t.department = r.custom_department
      teamsMap.set(teamName, t)
    }
    const teams = [...teamsMap.values()].sort((a, b) => b.totals.sales_value - a.totals.sales_value)
    // "multiple sales team" = more than one MAPPED role profile (ignore the
    // single '(unmapped)' bucket on its own).
    const mappedTeams = teams.filter((t) => t.name !== '(unmapped)')
    const first = rs[0]
    const status = first.distStatus ?? 'unchecked'
    const sheetCodes = uniq(rs.map((r) => distributorCodeOf(r.raw)))
    const erpEbs = uniq(rs.flatMap((r) => r.custEbsCodes ?? []))
    // The sheet's EBS is "correct" when every Stockist Code it carries is one of
    // the resolved customer's ERP EBS codes (primary OR secondary column). Only
    // meaningful once the customer resolved — otherwise the match status covers it.
    const erpUp = new Set(erpEbs.map((c) => c.toUpperCase()))
    const ebsMatch: 'ok' | 'mismatch' | 'na' =
      status === 'ok' && sheetCodes.length > 0 ? (sheetCodes.every((c) => erpUp.has(c.toUpperCase())) ? 'ok' : 'mismatch') : 'na'
    groups.push({
      id: key,
      customer: first.resolvedDistributor || key,
      status,
      ebsCodes: sheetCodes,
      erpEbs,
      ebsMatch,
      sheetNames: uniq(rs.map((r) => distributorOf(r.raw))),
      hqs: uniq(rs.map((r) => r.custom_hq || '')),
      dates: uniq(rs.map((r) => dateOf(r.raw))),
      rows: rs,
      teams,
      totals,
      itemCount: rs.length,
      multiTeam: mappedTeams.length > 1,
    })
  }
  groups.sort((a, b) => b.totals.sales_value - a.totals.sales_value)
  return groups
}

// A single sheet line that did NOT reconcile: the customer (EBS) didn't resolve,
// or the item didn't resolve to a UAT Item. Surfaced as its own list so a bad
// EBS/item match is visible with its sheet vs ERP names and quantities.
interface Problem {
  ebs: string
  customer: string
  sheetItem: string
  erpItem: string
  issue: string
  salesQty: number
  salesVal: number
}

function buildProblems(rows: RowRec[]): Problem[] {
  const out: Problem[] = []
  for (const r of rows) {
    const custBad = r.distStatus && r.distStatus !== 'ok'
    const itemBad = r.itemStatus && r.itemStatus !== 'ok' && r.itemStatus !== 'skip'
    if (!custBad && !itemBad) continue
    const issues: string[] = []
    if (r.distStatus === 'missing') issues.push('customer (EBS) not found in UAT')
    if (r.distStatus === 'ambiguous') issues.push(`customer ambiguous (${(r.distOptions || []).length})`)
    if (r.itemStatus === 'missing') issues.push('item not found in UAT')
    if (r.itemStatus === 'ambiguous') issues.push(`item ambiguous (${(r.itemOptions || []).length})`)
    out.push({
      ebs: distributorCodeOf(r.raw),
      customer: r.resolvedDistributor || distributorOf(r.raw),
      sheetItem: firstValue(r.raw, ['Product', 'Product Code']),
      erpItem: r.resolvedItem || '',
      issue: issues.join(' · '),
      salesQty: numOf(r.raw, 'sales_qty'),
      salesVal: numOf(r.raw, 'sales_value'),
    })
  }
  return out
}

// Turn EBS-code mismatch groups into problem rows (led list) — a resolved
// customer whose sheet Stockist Code is on neither ERP EBS column.
function ebsMismatchProblems(grps: EbsGroup[]): Problem[] {
  return grps
    .filter((g) => g.ebsMatch === 'mismatch')
    .map((g) => ({
      ebs: g.ebsCodes.join(', '),
      customer: g.customer,
      sheetItem: '(customer EBS)',
      erpItem: g.erpEbs.join(', ') || '(none)',
      issue: `sheet EBS ${g.ebsCodes.join(', ')} is not on the resolved customer (ERP EBS: ${g.erpEbs.join(', ') || 'none'})`,
      salesQty: g.totals.sales_qty,
      salesVal: g.totals.sales_value,
    }))
}

export default function EbsValidationPage() {
  const [session, setSession] = useState<SessionRec | null>(null)
  const [allRows, setAllRows] = useState<RowRec[]>([])
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [onlyMulti, setOnlyMulti] = useState(false)
  const [onlyUnmatched, setOnlyUnmatched] = useState(false)
  const [drawer, setDrawer] = useState<EbsGroup | null>(null)
  // ERP-posted totals per resolved customer (sheet-vs-ERP comparison). Populated
  // on demand by "Compare with ERP"; empty until then so the table shows sheet
  // figures only.
  const [erpTotals, setErpTotals] = useState<Map<string, Totals>>(new Map())
  const [erpFetched, setErpFetched] = useState(false)
  const [erpBusy, setErpBusy] = useState(false)
  const [erpError, setErpError] = useState('')

  useEffect(() => {
    ;(async () => {
      const s = await latestSession()
      if (!s) {
        setLoading(false)
        return
      }
      setSession(s)
      const rows = await getDb().rows.where('sessionId').equals(s.id).toArray()
      rows.sort((a, b) => (a.rid || 0) - (b.rid || 0))
      setAllRows(rows)
      setSelectedFiles(new Set(rows.map((r) => r.fileName))) // show every loaded file by default
      setLoading(false)
    })()
  }, [])

  // Loaded files (sheets) in this session — pick which to validate.
  const files = useMemo(() => [...new Set(allRows.map((r) => r.fileName))].sort(), [allRows])
  const toggleFile = (f: string) =>
    setSelectedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(f)) next.delete(f)
      else next.add(f)
      return next
    })

  // Everything downstream is derived from ONLY the selected files — no reload.
  const { groups, problems } = useMemo(() => {
    const rows = allRows.filter((r) => selectedFiles.has(r.fileName))
    const grps = buildGroups(rows)
    return { groups: grps, problems: [...ebsMismatchProblems(grps), ...buildProblems(rows)] }
  }, [allRows, selectedFiles])

  const stats = useMemo(() => {
    let matched = 0
    let attention = 0
    let multi = 0
    for (const g of groups) {
      if (g.status === 'ok') matched++
      if (g.status === 'ambiguous' || g.status === 'missing') attention++
      if (g.multiTeam) multi++
    }
    return { total: groups.length, matched, attention, multi }
  }, [groups])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return groups.filter((g) => {
      if (onlyMulti && !g.multiTeam) return false
      if (onlyUnmatched && g.status === 'ok') return false
      if (q) {
        const hay = `${g.customer} ${g.ebsCodes.join(' ')} ${g.sheetNames.join(' ')} ${g.teams.map((t) => t.name).join(' ')}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [groups, search, onlyMulti, onlyUnmatched])

  // Changing the selected sheets makes any prior ERP comparison stale — clear it.
  useEffect(() => {
    setErpFetched(false)
    setErpTotals(new Map())
    setErpError('')
  }, [selectedFiles])

  // Fetch what is already posted in ERP for the resolved customers, scoped to the
  // sheet's own date range, and stash the per-customer totals for the sheet-vs-ERP
  // columns.
  async function compareErp() {
    setErpBusy(true)
    setErpError('')
    try {
      const customers = [...new Set(groups.filter((g) => g.status === 'ok').map((g) => g.customer))]
      const rows = allRows.filter((r) => selectedFiles.has(r.fileName))
      const dates = rows.map((r) => dateOf(r.raw)).filter(Boolean).sort()
      const from = dates[0]
      const to = dates[dates.length - 1]
      const res = await fetch('/api/erp/secondary-totals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customers, from, to }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((body.detail as string) || (body.error as string) || `HTTP ${res.status}`)
      const m = new Map<string, Totals>()
      for (const [k, v] of Object.entries((body.totals || {}) as Record<string, Totals>)) m.set(k, v)
      setErpTotals(m)
      setErpFetched(true)
    } catch (e) {
      setErpError(e instanceof Error ? e.message : String(e))
    } finally {
      setErpBusy(false)
    }
  }

  // ERP total for a group's resolved customer — only meaningful once compared and
  // when the customer resolved to UAT.
  const erpOf = (g: EbsGroup): Totals | undefined => (erpFetched && g.status === 'ok' ? erpTotals.get(g.customer) : undefined)

  const columns: VColumn<EbsGroup>[] = [
    {
      key: 'ebs',
      header: 'EBS (sheet → ERP)',
      width: 200,
      render: (g) => (
        <span className="mono">
          {g.ebsCodes.join(', ') || '—'}
          <span style={{ color: g.ebsMatch === 'ok' ? 'var(--green)' : g.ebsMatch === 'mismatch' ? 'var(--red)' : 'var(--muted)' }}>
            {' → '}
            {g.erpEbs.join(', ') || '—'}
          </span>
        </span>
      ),
    },
    {
      key: 'ebsCheck',
      header: 'EBS check',
      width: 100,
      render: (g) =>
        g.ebsMatch === 'ok' ? (
          <span style={{ color: 'var(--green)' }}>✓ match</span>
        ) : g.ebsMatch === 'mismatch' ? (
          <span style={{ color: 'var(--red)' }} title={`ERP EBS: ${g.erpEbs.join(', ') || 'none'}`}>✗ mismatch</span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      key: 'customer',
      header: 'Customer (sheet → UAT)',
      width: 340,
      render: (g) => (
        <span>
          <span className={`pill ${g.status === 'ok' ? 'ready' : g.status === 'unchecked' ? '' : 'error'}`} style={{ marginRight: 8 }}>
            {g.status}
          </span>
          <span className="muted">{g.sheetNames.join(', ') || '—'}</span>
          {' → '}
          {g.customer}
        </span>
      ),
    },
    { key: 'hq', header: 'HQ', width: 130, render: (g) => g.hqs.join(', ') || <span className="muted">—</span> },
    { key: 'items', header: 'Items', width: 60, render: (g) => g.itemCount },
    { key: 'sqty', header: 'Sec. Qty (sheet → ERP)', width: 190, render: (g) => <NumPair sheet={g.totals.sales_qty} erp={erpOf(g)?.sales_qty} shown={erpFetched && g.status === 'ok'} /> },
    { key: 'sval', header: 'Sec. Value (sheet → ERP)', width: 210, render: (g) => <NumPair sheet={g.totals.sales_value} erp={erpOf(g)?.sales_value} shown={erpFetched && g.status === 'ok'} /> },
    { key: 'cqty', header: 'Clos. Qty (sheet → ERP)', width: 190, render: (g) => <NumPair sheet={g.totals.closing_qty} erp={erpOf(g)?.closing_qty} shown={erpFetched && g.status === 'ok'} /> },
    { key: 'cval', header: 'Clos. Value (sheet → ERP)', width: 210, render: (g) => <NumPair sheet={g.totals.closing_balance} erp={erpOf(g)?.closing_balance} shown={erpFetched && g.status === 'ok'} /> },
    {
      key: 'teams',
      header: 'Sales teams',
      width: 140,
      render: (g) => (
        <span>
          {g.teams.filter((t) => t.name !== '(unmapped)').length || '—'}
          {g.multiTeam && <span className="pill amber" style={{ marginLeft: 8 }}>multi</span>}
        </span>
      ),
    },
  ]

  if (loading) return <p className="muted">Loading session…</p>
  if (!session || allRows.length === 0)
    return (
      <div className="panel">
        <p className="muted">No session loaded yet.</p>
        <Link href="/entry"><button className="primary">Go to Entry and load sheets</button></Link>
      </div>
    )

  return (
    <ErrorBoundary>
      {files.length > 1 && (
        <section className="panel">
          <div className="row-flex spread" style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>Loaded sheets <span className="hint">tick the sheet(s) to validate — everything below is just these</span></h2>
            <div className="row-flex" style={{ gap: 8 }}>
              <button onClick={() => setSelectedFiles(new Set(files))}>All</button>
              <button onClick={() => setSelectedFiles(new Set())}>None</button>
            </div>
          </div>
          <div className="row-flex" style={{ flexWrap: 'wrap', gap: 12 }}>
            {files.map((f) => (
              <label key={f} className="row-flex" style={{ gap: 6 }}>
                <input type="checkbox" checked={selectedFiles.has(f)} onChange={() => toggleFile(f)} /> {f}
              </label>
            ))}
          </div>
        </section>
      )}

      <div className="kpis">
        <div className="kpi"><div className="label">Customers</div><div className="value">{stats.total.toLocaleString()}</div></div>
        <div className="kpi green"><div className="label">Matched to UAT</div><div className="value">{stats.matched.toLocaleString()}</div></div>
        <div className="kpi red"><div className="label">Needs attention</div><div className="value">{stats.attention.toLocaleString()}</div></div>
        <div className="kpi amber"><div className="label">Multiple sales teams</div><div className="value">{stats.multi.toLocaleString()}</div></div>
        <div className="kpi red"><div className="label">Unmatched lines</div><div className="value">{problems.length.toLocaleString()}</div></div>
      </div>

      {problems.length > 0 && (
        <section className="panel">
          <h2>
            Errors & mismatches <span className="hint">{problems.length.toLocaleString()} lines where the EBS/customer or item didn’t match UAT — fix these before writing</span>
          </h2>
          <VirtualTable
            rows={problems}
            columns={[
              { key: 'ebs', header: 'EBS code', width: 110, render: (p) => <span className="mono">{p.ebs || '—'}</span> },
              { key: 'customer', header: 'Customer', width: 240, render: (p) => p.customer || <span className="muted">—</span> },
              { key: 'sheetItem', header: 'Item (sheet)', width: 200, render: (p) => <span className="mono">{p.sheetItem || '—'}</span> },
              { key: 'erpItem', header: 'Item (ERP)', width: 200, render: (p) => (p.erpItem ? <span className="mono" style={{ color: 'var(--green)' }}>{p.erpItem}</span> : <span style={{ color: 'var(--red)' }}>not matched</span>) },
              { key: 'sqty', header: 'Sec. Qty', width: 90, render: (p) => <span className="mono">{fmt(p.salesQty)}</span> },
              { key: 'sval', header: 'Sec. Value', width: 110, render: (p) => <span className="mono">{fmt(p.salesVal)}</span> },
              { key: 'issue', header: 'Issue', width: 320, render: (p) => <span style={{ color: 'var(--red)' }}>{p.issue}</span> },
            ]}
            height={Math.min(360, 60 + problems.length * 34)}
            empty="No mismatches"
          />
        </section>
      )}

      <section className="panel">
        <div className="row-flex spread">
          <h2>
            By customer <span className="hint">{visible.length.toLocaleString()} of {stats.total.toLocaleString()} · click a row to see the sales-team breakdown</span>
          </h2>
          <div className="row-flex" style={{ gap: 10 }}>
            {erpError && <span className="small" style={{ color: 'var(--red)' }}>{erpError}</span>}
            {erpFetched && !erpError && <span className="small muted">ERP compared · {erpTotals.size.toLocaleString()} posted</span>}
            <button className="primary" onClick={compareErp} disabled={erpBusy}>
              {erpBusy ? 'Comparing…' : erpFetched ? 'Re-compare with ERP' : 'Compare with ERP'}
            </button>
          </div>
        </div>
        <div className="row-flex" style={{ marginBottom: 12 }}>
          <label className="row-flex" style={{ gap: 6 }}>
            <input type="checkbox" checked={onlyMulti} onChange={(e) => setOnlyMulti(e.target.checked)} /> Only multiple sales teams
          </label>
          <label className="row-flex" style={{ gap: 6 }}>
            <input type="checkbox" checked={onlyUnmatched} onChange={(e) => setOnlyUnmatched(e.target.checked)} /> Only needs attention
          </label>
          <input type="text" placeholder="Search customer / EBS / team…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
        </div>
        <VirtualTable rows={visible} columns={columns} onRowClick={setDrawer} height={560} empty="No customers match the filters" />
      </section>

      {drawer && (
        <EbsDrawer
          g={drawer}
          erp={erpFetched && drawer.status === 'ok' ? erpTotals.get(drawer.customer) : undefined}
          onClose={() => setDrawer(null)}
        />
      )}
    </ErrorBoundary>
  )
}

function TotalsRow({ totals }: { totals: Totals }) {
  return (
    <div className="kv">
      {QTY_KEYS.map(([key, label]) => (
        <div key={key} style={{ display: 'contents' }}>
          <span className="k">{label}</span>
          <span className="mono">{fmt(totals[key])}</span>
        </div>
      ))}
    </div>
  )
}

function EbsDrawer({ g, erp, onClose }: { g: EbsGroup; erp?: Totals; onClose: () => void }) {
  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="drawer">
        <div className="row-flex spread">
          <h3>{g.customer}</h3>
          <button onClick={onClose}>Close</button>
        </div>
        <p className="muted small">
          <span className="mono">{g.ebsCodes.join(', ') || 'no EBS code'}</span> ·{' '}
          <span className={`pill ${g.status === 'ok' ? 'ready' : g.status === 'unchecked' ? '' : 'error'}`}>{g.status}</span> ·{' '}
          {g.dates.join(', ')} · {g.itemCount} lines
        </p>
        <div className="kv">
          <span className="k">Sheet EBS</span>
          <span className="mono">{g.ebsCodes.join(', ') || '—'}</span>
          <span className="k">ERP EBS (both columns)</span>
          <span className="mono">{g.erpEbs.join(', ') || '—'}</span>
          <span className="k">EBS check</span>
          <span style={{ color: g.ebsMatch === 'ok' ? 'var(--green)' : g.ebsMatch === 'mismatch' ? 'var(--red)' : 'inherit' }}>
            {g.ebsMatch === 'ok' ? '✓ sheet EBS matches an ERP column' : g.ebsMatch === 'mismatch' ? '✗ sheet EBS not on the ERP customer' : '— not checked'}
          </span>
        </div>
        {g.sheetNames.length > 0 && (
          <p className="muted small">Sheet name(s): {g.sheetNames.map((n) => <span key={n} className="mono" style={{ marginRight: 8 }}>{n}</span>)}</p>
        )}

        <h4>Customer total {erp ? '(sheet → ERP posted)' : '(from the sheet)'}</h4>
        {erp ? (
          <div className="kv">
            {QTY_KEYS.map(([key, label]) => (
              <div key={key} style={{ display: 'contents' }}>
                <span className="k">{label}</span>
                <NumPair sheet={g.totals[key]} erp={erp[key]} shown />
              </div>
            ))}
          </div>
        ) : (
          <TotalsRow totals={g.totals} />
        )}

        <h4>
          Sales teams ({g.teams.filter((t) => t.name !== '(unmapped)').length})
          {g.multiTeam && <span className="pill amber" style={{ marginLeft: 8 }}>multiple</span>}
        </h4>
        {g.teams.map((t) => (
          <div key={t.name} className="panel" style={{ marginBottom: 10 }}>
            <div className="row-flex spread">
              <strong>{t.name}</strong>
              <span className="muted small">{t.hq}{t.department ? ` · ${t.department}` : ''} · {t.rows.length} items</span>
            </div>
            <TotalsRow totals={t.totals} />
            <div className="kv" style={{ marginTop: 6 }}>
              {t.rows.map((r, i) => (
                <div key={i} style={{ display: 'contents' }}>
                  <span className="k">{r.resolvedItem || firstValue(r.raw, ['Product', 'Product Code'])}</span>
                  <span className="mono">Sec {fmt(numOf(r.raw, 'sales_qty'))} / {fmt(numOf(r.raw, 'sales_value'))}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
