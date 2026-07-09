import { NextResponse } from 'next/server'
import { assertConfigured, listDocs } from '@/lib/server/erpnext'
import { normalizeItem, aliasKey } from '@/lib/shared/mapping'
import { ITEM_ALIASES } from '@/lib/shared/aliases'

// Manual aliases keyed by the space-preserving alias key → canonical UAT name.
const ALIAS_BY_KEY = new Map<string, string>(Object.entries(ITEM_ALIASES).map(([k, v]) => [aliasKey(k), v]))

// POST { names: string[] }  → { resolved: { [sheetName]: ItemMatch } }
// Maps freehand sheet product names to the canonical UAT Item name using a
// normalized nomenclature key (see normalizeItem). Exact normalized match wins;
// if the sheet name was truncated, a UNIQUE prefix match is accepted; multiple
// candidates are "ambiguous" (must be fixed in the sheet); none is "missing".
//
// The index is restricted to item_group = "Products" — the SAME set the
// Secondary Data Table's `item` Link field allows in ERPNext — so we never
// match packaging / -SCP / cylinder / sticker items that the doc would reject.
const ITEM_GROUP = 'Products'
export interface ItemMatch {
  status: 'ok' | 'ambiguous' | 'missing'
  name: string // canonical UAT Item name when status === 'ok'
  options?: string[] // candidate names when ambiguous
}

interface ItemIndex {
  byNorm: Map<string, string[]>
  norms: string[]
  loadedAt: number
}

// Cached across warm invocations (best effort — a cold start just rebuilds).
let cache: ItemIndex | null = null
const TTL_MS = 10 * 60 * 1000
const PAGE = 500
const HARD_CAP = 60000

async function getIndex(): Promise<ItemIndex> {
  if (cache && Date.now() - cache.loadedAt < TTL_MS) return cache
  const byNorm = new Map<string, string[]>()
  let offset = 0
  for (;;) {
    const docs = await listDocs('Item', [['item_group', '=', ITEM_GROUP]], ['name'], { limit: PAGE, offset })
    for (const d of docs) {
      const nm = String(d.name)
      const norm = normalizeItem(nm)
      if (!norm) continue
      const arr = byNorm.get(norm)
      if (arr) arr.push(nm)
      else byNorm.set(norm, [nm])
    }
    if (docs.length < PAGE) break
    offset += docs.length
    if (offset > HARD_CAP) break
  }
  cache = { byNorm, norms: [...byNorm.keys()], loadedAt: Date.now() }
  return cache
}

function match(idx: ItemIndex, raw: string): ItemMatch {
  // Manual alias (space-preserving key) redirects the search to the canonical
  // UAT name; we then match that against the Item master so we still return the
  // exact record spelling (and flag it if the target isn't in the Products group).
  const aliasTarget = ALIAS_BY_KEY.get(aliasKey(raw))
  const norm = normalizeItem(aliasTarget || raw)
  if (!norm) return { status: 'missing', name: '' }

  const exact = idx.byNorm.get(norm)
  if (exact && exact.length === 1) return { status: 'ok', name: exact[0] }
  if (exact && exact.length > 1) return { status: 'ambiguous', name: '', options: exact }

  // Truncated sheet name → accept only a UNIQUE prefix candidate.
  const names = idx.norms.filter((n) => n.startsWith(norm)).flatMap((n) => idx.byNorm.get(n) || [])
  if (names.length === 1) return { status: 'ok', name: names[0] }
  if (names.length > 1) return { status: 'ambiguous', name: '', options: names.slice(0, 8) }
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
    const resolved: Record<string, ItemMatch> = {}
    for (const n of names) if (!(n in resolved)) resolved[n] = match(idx, n)
    return NextResponse.json({ resolved, itemCount: idx.byNorm.size })
  } catch (err) {
    return NextResponse.json({ error: 'Item resolve failed', detail: err instanceof Error ? err.message : String(err) }, { status: 502 })
  }
}
