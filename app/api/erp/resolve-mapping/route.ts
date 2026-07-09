import { NextResponse } from 'next/server'
import { assertConfigured } from '@/lib/server/erpnext'
import { resolveDistributorMapping } from '@/lib/server/erpMapping'

// POST { distributor, date, items?: string[] } -> { itemMap, conflicts, unmapped, departments }
export async function POST(req: Request) {
  try { assertConfigured() } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 503 }) }
  const body = await req.json().catch(() => ({}))
  const { distributor, date, items } = body || {}
  if (!distributor || !date) return NextResponse.json({ error: 'distributor and date are required' }, { status: 400 })
  try {
    const result = await resolveDistributorMapping(distributor, date, Array.isArray(items) ? items : undefined)
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json({ error: 'resolve mapping failed', detail: err instanceof Error ? err.message : String(err) }, { status: 502 })
  }
}
