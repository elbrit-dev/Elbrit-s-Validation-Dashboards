import { NextResponse } from 'next/server'
import { assertConfigured, listDocs } from '@/lib/server/erpnext'
import { normalizeCustomer } from '@/lib/shared/mapping'
import { CUSTOMER_ALIASES } from '@/lib/shared/aliases'

// POST { names: string[] }  → { resolved: { [sheetStockist]: CustomerMatch } }
// Maps freehand sheet stockist names to the canonical UAT Customer name using a
// case/punctuation-insensitive key. Exact match wins; CUSTOMER_ALIASES handles
// the wording differences (e.g. "DIVYA PHARMA DIST" → "Divya Pharma
// Distributors Pvt Ltd"). No fuzzy/prefix matching — customer names collide too
// easily, so anything not exact or aliased is reported "missing" for a fix.
export interface CustomerMatch {
  status: 'ok' | 'ambiguous' | 'missing'
  name: string
  options?: string[]
}

interface CustIndex {
  byNorm: Map<string, string[]>
  names: Set<string> // exact customer names (for alias targets)
  byEbs: Map<string, string[]> // UPPERCASE EBS code (whg_ebs_code) → customer name(s)
  loadedAt: number
}

// An alias target of the form "EBS708" pins a sheet name to ONE of several
// look-alike customers by their unique EBS code, instead of the (ambiguous) name.
const EBS_RE = /^EBS\d+$/i

// Alias key: uppercase, drop ALL whitespace, but KEEP punctuation. Dropping
// spaces means "R.S.DRUGS..." == "R.S. DRUGS..."; keeping dots means "M M Pharma"
// (→ MMPHARMA) stays distinct from "M.M. Pharma" (→ M.M.PHARMA), which map to
// two different UAT customers.
const aliasCustKey = (s: string) => String(s ?? '').replace(/[^\x00-\x7F]/g, '').replace(/\s+/g, '').toUpperCase()
const ALIAS_BY_KEY = new Map<string, string>(Object.entries(CUSTOMER_ALIASES).map(([k, v]) => [aliasCustKey(k), v]))

let cache: CustIndex | null = null
const TTL_MS = 10 * 60 * 1000
const PAGE = 500
const HARD_CAP = 100000

async function getIndex(): Promise<CustIndex> {
  if (cache && Date.now() - cache.loadedAt < TTL_MS) return cache
  const byNorm = new Map<string, string[]>()
  const names = new Set<string>()
  const byEbs = new Map<string, string[]>()
  let offset = 0
  for (;;) {
    const docs = await listDocs('Customer', [], ['name', 'whg_ebs_code'], { limit: PAGE, offset })
    for (const d of docs) {
      const nm = String(d.name)
      names.add(nm)
      const ebs = String(d.whg_ebs_code ?? '').trim().toUpperCase()
      if (ebs) {
        const e = byEbs.get(ebs)
        if (e) e.push(nm)
        else byEbs.set(ebs, [nm])
      }
      const norm = normalizeCustomer(nm)
      if (!norm) continue
      const arr = byNorm.get(norm)
      if (arr) arr.push(nm)
      else byNorm.set(norm, [nm])
    }
    if (docs.length < PAGE) break
    offset += docs.length
    if (offset > HARD_CAP) break
  }
  cache = { byNorm, names, byEbs, loadedAt: Date.now() }
  return cache
}

function match(idx: CustIndex, raw: string): CustomerMatch {
  // A manual alias points at the EXACT UAT customer — trust it (skip the
  // ambiguity check). The target is either an EBS code ("EBS708" → resolve by the
  // unique whg_ebs_code, to pin one of several same-named customers) or an exact
  // customer name. Either way it must exist in UAT.
  const aliasTarget = ALIAS_BY_KEY.get(aliasCustKey(raw))
  if (aliasTarget) {
    if (EBS_RE.test(aliasTarget)) {
      const hit = idx.byEbs.get(aliasTarget.toUpperCase())
      if (hit && hit.length === 1) return { status: 'ok', name: hit[0] }
      if (hit && hit.length > 1) return { status: 'ambiguous', name: '', options: hit }
      return { status: 'missing', name: '' }
    }
    return idx.names.has(aliasTarget) ? { status: 'ok', name: aliasTarget } : { status: 'missing', name: '' }
  }

  const norm = normalizeCustomer(raw)
  if (!norm) return { status: 'missing', name: '' }
  const hit = idx.byNorm.get(norm)
  if (hit && hit.length === 1) return { status: 'ok', name: hit[0] }
  if (hit && hit.length > 1) return { status: 'ambiguous', name: '', options: hit }
  return { status: 'missing', name: '' }
}

export async function POST(req: Request) {
  try {
    assertConfigured()
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 })
  }
  const body = await req.json().catch(() => ({}))
  const names: string[] = Array.isArray(body?.names) ? body.names.filter((n: unknown) => typeof n === 'string' && n.trim() !== '') : []
  if (names.length === 0) return NextResponse.json({ resolved: {} })

  try {
    const idx = await getIndex()
    const resolved: Record<string, CustomerMatch> = {}
    for (const n of names) if (!(n in resolved)) resolved[n] = match(idx, n)
    return NextResponse.json({ resolved, customerCount: idx.byNorm.size })
  } catch (err) {
    return NextResponse.json({ error: 'Customer resolve failed', detail: err instanceof Error ? err.message : String(err) }, { status: 502 })
  }
}
