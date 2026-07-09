'use client'
// Validation dashboard over the loaded session — severity-weighted rule engine
// (same pattern as the doctor tool), KPI cards, per-rule distribution and a
// filterable virtualized table with drilldown.
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import ErrorBoundary from '@/components/ErrorBoundary'
import VirtualTable, { type VColumn } from '@/components/VirtualTable'
import { getDb, latestSession, type RowRec, type SessionRec } from '@/lib/client/db'
import { RULES, RULE_BY_ID, validateRow, numOf, type RowIssues } from '@/lib/validation/rules'
import { distributorOf, firstValue } from '@/lib/shared/mapping'
import { exportXlsx } from '@/lib/client/workers'

interface VRow {
  row: RowRec
  issues: RowIssues
}

type Tab = 'all' | 'error' | 'warning' | 'ready'

export default function ValidationPage() {
  const [session, setSession] = useState<SessionRec | null>(null)
  const [vrows, setVrows] = useState<VRow[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('all')
  const [ruleFilter, setRuleFilter] = useState('')
  const [monthFilter, setMonthFilter] = useState('')
  const [search, setSearch] = useState('')
  const [drawer, setDrawer] = useState<VRow | null>(null)

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
      setVrows(rows.map((row) => ({ row, issues: validateRow({ raw: row.raw, itemStatus: row.itemStatus, distStatus: row.distStatus }) })))
      setLoading(false)
    })()
  }, [])

  const stats = useMemo(() => {
    const s = { total: vrows.length, error: 0, warning: 0, ready: 0, scoreSum: 0 }
    const perRule = new Map<string, number>()
    for (const v of vrows) {
      s[v.issues.status]++
      s.scoreSum += v.issues.score
      for (const id of v.issues.ruleIds) perRule.set(id, (perRule.get(id) || 0) + 1)
    }
    return { ...s, avgScore: s.total ? Math.round(s.scoreSum / s.total) : 0, perRule }
  }, [vrows])

  const months = useMemo(() => [...new Set(vrows.map((v) => v.row.monthTag))], [vrows])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return vrows.filter((v) => {
      if (tab !== 'all' && v.issues.status !== tab) return false
      if (ruleFilter && !v.issues.ruleIds.includes(ruleFilter)) return false
      if (monthFilter && v.row.monthTag !== monthFilter) return false
      if (q) {
        const hay = `${v.row.key} ${Object.values(v.row.raw).join(' ')}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [vrows, tab, ruleFilter, monthFilter, search])

  const doExport = async () => {
    await exportXlsx(
      [
        {
          name: 'Validation',
          rows: vrows.map((v) => ({
            key: v.row.key,
            month: v.row.monthTag,
            status: v.issues.status,
            score: v.issues.score,
            issues: v.issues.ruleIds.map((id) => RULE_BY_ID[id]?.label || id).join(', '),
            ...v.row.raw,
          })),
        },
        {
          name: 'Per rule',
          rows: RULES.map((r) => ({ rule: r.label, severity: r.severity, failing: stats.perRule.get(r.id) || 0 })),
        },
      ],
      `validation-${session?.id || 'export'}.xlsx`,
    )
  }

  const columns: VColumn<VRow>[] = [
    { key: 'key', header: 'Code', width: 110, render: (v) => <span className="mono">{v.row.key || '—'}</span> },
    { key: 'month', header: 'Month', width: 90, render: (v) => v.row.monthTag },
    { key: 'status', header: 'Status', width: 100, render: (v) => <span className={`pill ${v.issues.status}`}>{v.issues.status}</span> },
    { key: 'score', header: 'Score', width: 70, render: (v) => v.issues.score },
    {
      key: 'issues',
      header: 'Issues',
      width: 460,
      render: (v) => v.issues.ruleIds.map((id) => RULE_BY_ID[id]?.label || id).join(', ') || <span className="muted">clean</span>,
    },
  ]

  if (loading) return <p className="muted">Loading session…</p>
  if (!session || vrows.length === 0)
    return (
      <div className="panel">
        <p className="muted">No session loaded yet.</p>
        <Link href="/entry"><button className="primary">Go to Entry and load sheets</button></Link>
      </div>
    )

  const sev = (r: (typeof RULES)[number]) => (r.severity === 'error' ? 'var(--red)' : r.severity === 'warning' ? 'var(--amber)' : 'var(--blue)')

  return (
    <ErrorBoundary>
      <div className="kpis">
        <div className="kpi"><div className="label">Rows</div><div className="value">{stats.total.toLocaleString()}</div></div>
        <div className="kpi blue"><div className="label">Avg quality score</div><div className="value">{stats.avgScore}</div></div>
        <div className="kpi red"><div className="label">Errors</div><div className="value">{stats.error.toLocaleString()}</div></div>
        <div className="kpi amber"><div className="label">Warnings</div><div className="value">{stats.warning.toLocaleString()}</div></div>
        <div className="kpi green"><div className="label">Ready</div><div className="value">{stats.ready.toLocaleString()}</div></div>
      </div>

      <section className="panel">
        <h2>Failures per check <span className="hint">click a bar to filter the table</span></h2>
        <div className="bars">
          {RULES.map((r) => {
            const n = stats.perRule.get(r.id) || 0
            const pct = stats.total ? (n / stats.total) * 100 : 0
            return (
              <div key={r.id} className="bar-row" style={{ cursor: 'pointer', opacity: ruleFilter && ruleFilter !== r.id ? 0.45 : 1 }} onClick={() => setRuleFilter(ruleFilter === r.id ? '' : r.id)}>
                <span>{r.label}</span>
                <div className="bar-track"><div className="bar-fill" style={{ width: `${pct}%`, background: sev(r) }} /></div>
                <span className="muted">{n.toLocaleString()}</span>
              </div>
            )
          })}
        </div>
      </section>

      <section className="panel">
        <h2>
          Rows <span className="hint">{visible.length.toLocaleString()} of {stats.total.toLocaleString()}</span>
        </h2>
        <div className="row-flex" style={{ marginBottom: 12 }}>
          <div className="tabs" style={{ margin: 0 }}>
            {(['all', 'error', 'warning', 'ready'] as Tab[]).map((t) => (
              <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                {t}{t !== 'all' && ` (${stats[t].toLocaleString()})`}
              </button>
            ))}
          </div>
          <select value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)}>
            <option value="">All months</option>
            {months.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <select value={ruleFilter} onChange={(e) => setRuleFilter(e.target.value)}>
            <option value="">All checks</option>
            {RULES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
          <input type="text" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
          <button onClick={doExport}>⬇ Export</button>
        </div>
        <VirtualTable rows={visible} columns={columns} onRowClick={setDrawer} height={520} empty="No rows match the filters" />
      </section>

      {drawer && <ValidationDrawer v={drawer} onClose={() => setDrawer(null)} />}
    </ErrorBoundary>
  )
}

// One "sheet value → UAT value" line in the drawer's UAT-match block.
function MatchLine({
  sheet,
  resolved,
  status,
  options,
}: {
  sheet: string
  resolved?: string
  status?: 'ok' | 'ambiguous' | 'missing'
  options?: string[]
}) {
  if (!status) return <span className="muted">— run “Check with UAT” first</span>
  if (status === 'ok')
    return (
      <span>
        <span className="mono">{sheet}</span> → <span className="mono" style={{ color: 'var(--green)' }}>{resolved}</span>
      </span>
    )
  return (
    <span style={{ color: 'var(--red)' }} title={(options || []).join(', ')}>
      <span className="mono">{sheet}</span> → ✗ {status === 'missing' ? 'not found in UAT' : `ambiguous (${(options || []).length} matches)`}
    </span>
  )
}

function ValidationDrawer({ v, onClose }: { v: VRow; onClose: () => void }) {
  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="drawer">
        <div className="row-flex spread">
          <h3 className="mono">{v.row.key || '(no code)'}</h3>
          <button onClick={onClose}>Close</button>
        </div>
        <p className="muted small">
          {v.row.fileName} · {v.row.monthTag} · <span className={`pill ${v.issues.status}`}>{v.issues.status}</span> · score {v.issues.score}
        </p>
        <h4>UAT match</h4>
        <div className="kv">
          <div style={{ display: 'contents' }}>
            <span className="k">Distributor → UAT</span>
            <MatchLine sheet={distributorOf(v.row.raw)} resolved={v.row.resolvedDistributor} status={v.row.distStatus} options={v.row.distOptions} />
          </div>
          <div style={{ display: 'contents' }}>
            <span className="k">Item → UAT</span>
            <MatchLine sheet={firstValue(v.row.raw, ['Product', 'Product Code'])} resolved={v.row.resolvedItem} status={v.row.itemStatus} options={v.row.itemOptions} />
          </div>
        </div>
        <h4>Quantities → UAT</h4>
        <div className="kv">
          {([
            ['Op. Qty', 'opening_qty'],
            ['Sec. Qty', 'sales_qty'],
            ['Sec. Value', 'sales_value'],
            ['Clos. Qty', 'closing_qty'],
            ['Clos. Value', 'closing_balance'],
          ] as const).map(([label, key]) => (
            <div key={key} style={{ display: 'contents' }}>
              <span className="k">{label}</span>
              <span className="mono">{numOf(v.row.raw, key).toLocaleString()}</span>
            </div>
          ))}
        </div>
        <h4>Checks</h4>
        <div className="kv">
          {RULES.map((r) => {
            const fail = v.issues.ruleIds.includes(r.id)
            // The two UAT-resolution checks are only meaningful after Check with
            // UAT has run — otherwise show "not checked" instead of a false pass.
            const needsUat =
              (r.id === 'item_unresolved' && v.row.itemStatus === undefined) ||
              (r.id === 'distributor_unresolved' && v.row.distStatus === undefined)
            return (
              <div key={r.id} style={{ display: 'contents' }}>
                <span className="k">{r.label}</span>
                {needsUat ? (
                  <span className="muted">— not checked (run “Check with UAT”)</span>
                ) : (
                  <span style={{ color: fail ? 'var(--red)' : 'var(--green)' }} title={fail ? r.fix : ''}>
                    {fail ? `✗ ${r.description}` : '✓ pass'}
                  </span>
                )}
              </div>
            )
          })}
        </div>
        <h4>Sheet row</h4>
        <div className="kv">
          {Object.entries(v.row.raw).map(([k, val]) => (
            <div key={k} style={{ display: 'contents' }}>
              <span className="k">{k}</span>
              <span>{String(val)}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
