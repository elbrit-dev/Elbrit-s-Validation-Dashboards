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
  byEbs: Map<string, string[]> // UPPERCASE EBS code (from any EBS field) → customer name(s)
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

// A Customer can carry its EBS code in more than one field: the primary
// whg_ebs_code ("EBS Code *") AND a secondary free-text "EBS Code" field holding
// an alternate/legacy code — e.g. Saraswathi Agencies = EBS069 (primary) +
// EBS643 (secondary), and the sheet's Stockist Code may be EITHER. We don't know
// the secondary field's exact name, so fetch all fields and pull EBS codes from
// any field that is EBS-named or whose whole value is just EBS code(s) (the
// secondary field is multiline and may list several). This stays entirely in the
// EBS-code lane — name/nomenclature matching is unaffected.
const EBS_TOKEN = /EBS\d+/gi
const PURE_EBS = /^(?:EBS\d+[\s,;]*)+$/i
const ebsCodesIn = (v: unknown): string[] => String(v ?? '').toUpperCase().match(EBS_TOKEN) ?? []

async function getIndex(): Promise<CustIndex> {
  if (cache && Date.now() - cache.loadedAt < TTL_MS) return cache
  const byNorm = new Map<string, string[]>()
  const names = new Set<string>()
  const byEbs = new Map<string, string[]>()
  const addEbs = (code: string, nm: string) => {
    const e = byEbs.get(code)
    if (e) { if (!e.includes(nm)) e.push(nm) } // dedupe: same code in two fields of one customer ≠ ambiguous
    else byEbs.set(code, [nm])
  }
  let offset = 0
  for (;;) {
    const docs = await listDocs('Customer', [], ['*'], { limit: PAGE, offset })
    for (const d of docs) {
      const nm = String(d.name)
      names.add(nm)
      for (const [k, v] of Object.entries(d)) {
        // Accept a field named like an EBS field, or one whose entire value is
        // EBS code(s) — avoids scraping "EBS123" out of an address/notes field.
        if (!/ebs/i.test(k) && !PURE_EBS.test(String(v ?? '').trim())) continue
        for (const code of ebsCodesIn(v)) addEbs(code, nm)
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

function byEbs(idx: CustIndex, ebs: string): CustomerMatch | null {
  const hit = idx.byEbs.get(ebs.trim().toUpperCase())
  if (hit && hit.length === 1) return { status: 'ok', name: hit[0] }
  if (hit && hit.length > 1) return { status: 'ambiguous', name: '', options: hit }
  return null
}

function match(idx: CustIndex, raw: string, code?: string): CustomerMatch {
  // 1) The sheet's own "Stockist Code" (EBS code) is the strongest signal: it
  // pins a look-alike stockist to the exact ERP branch by the unique
  // whg_ebs_code (EBS677 → "… Guindy", EBS385 → plain). When the code is present
  // and matches, trust it over the (ambiguous) name. If the code is present but
  // unknown to UAT, fall through to name resolution rather than hard-failing.
  if (code && EBS_RE.test(code.trim())) {
    const hit = byEbs(idx, code)
    if (hit) return hit
  }

  // 2) A manual alias points at the EXACT UAT customer — trust it (skip the
  // ambiguity check). The target is either an EBS code ("EBS708" → resolve by the
  // unique whg_ebs_code, to pin one of several same-named customers) or an exact
  // customer name. Either way it must exist in UAT.
  const aliasTarget = ALIAS_BY_KEY.get(aliasCustKey(raw))
  if (aliasTarget) {
    // An alias that explicitly names an EBS code MUST resolve to it — a miss is
    // a real config error, so don't fall back to the name here.
    if (EBS_RE.test(aliasTarget)) return byEbs(idx, aliasTarget) ?? { status: 'missing', name: '' }
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
  // Two shapes accepted. New: { items: [{ id, name, code }] } where `id` is the
  // caller's identity for the row (EBS code when present, else the name) and
  // `code` is the sheet Stockist Code used to pin the exact branch. Legacy:
  // { names: string[] } — resolved by name only, keyed by name.
  interface InItem { id: string; name: string; code?: string }
  const items: InItem[] = Array.isArray(body?.items)
    ? body.items
        .filter((it: unknown): it is InItem => !!it && typeof (it as InItem).name === 'string' && (it as InItem).name.trim() !== '')
        .map((it: InItem) => ({ id: String(it.id ?? it.name), name: it.name, code: typeof it.code === 'string' ? it.code : '' }))
    : Array.isArray(body?.names)
      ? body.names.filter((n: unknown) => typeof n === 'string' && n.trim() !== '').map((n: string) => ({ id: n, name: n, code: '' }))
      : []
  if (items.length === 0) return NextResponse.json({ resolved: {} })

  try {
    const idx = await getIndex()
    const resolved: Record<string, CustomerMatch> = {}
    for (const it of items) if (!(it.id in resolved)) resolved[it.id] = match(idx, it.name, it.code)
    return NextResponse.json({ resolved, customerCount: idx.byNorm.size })
  } catch (err) {
    return NextResponse.json({ error: 'Customer resolve failed', detail: err instanceof Error ? err.message : String(err) }, { status: 502 })
  }
}
