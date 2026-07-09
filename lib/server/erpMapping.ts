import 'server-only'
import { ERP } from './env'
import { fetchRetry } from './retry'
import type { LineMapping, MappingResult } from '../shared/types'

// Server-side port of the ERPNext "Apply Mapping" button. For a distributor + date
// it resolves each item's sales team (role profile / hq / department) by cross-
// referencing the distributor's role profiles against which department sells the
// item (Item child table `Elbrit Department Table`, date-validity filtered).
// Uses /api/resource with the same token auth as lib/server/erpnext.ts.

const headers = () => ({ Authorization: `token ${ERP.key}:${ERP.secret}`, Accept: 'application/json' })

async function getJSON(path: string): Promise<{ data?: unknown }> {
  const r = await fetchRetry(`${ERP.base}${path}`, { headers: headers() })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`GET ${path.split('?')[0]}: HTTP ${r.status} ${body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`)
  }
  return r.json()
}

async function getDoc(doctype: string, name: string): Promise<Record<string, unknown> | null> {
  const j = await getJSON(`/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`)
  return (j.data as Record<string, unknown>) || null
}

async function getList(
  doctype: string,
  { filters, fields, limit = 0 }: { filters?: unknown; fields?: string[]; limit?: number } = {},
): Promise<Record<string, unknown>[]> {
  const qs = new URLSearchParams()
  if (fields) qs.set('fields', JSON.stringify(fields))
  if (filters) qs.set('filters', JSON.stringify(filters))
  qs.set('limit_page_length', String(limit))
  const j = await getJSON(`/api/resource/${encodeURIComponent(doctype)}?${qs}`)
  return (j.data as Record<string, unknown>[]) || []
}

interface RoleProfileRow { name: string; custom_department?: string; custom_territory?: string }
interface ItemDepRow { name?: string; dep?: string; valid_from?: string; valid_to?: string }

export async function resolveDistributorMapping(
  distributor: string,
  date: string,
  items?: string[],
): Promise<MappingResult> {
  const empty: MappingResult = { itemMap: {}, conflicts: {}, unmapped: items || [], departments: [] }

  // 1) Customer -> role profiles (child table custom_role_profile.role_profile_list)
  const cust = await getDoc('Customer', distributor)
  const roleRows = (cust?.custom_role_profile as Array<{ role_profile_list?: string }>) || []
  const roleNames = [...new Set(roleRows.map((r) => r.role_profile_list).filter((x): x is string => !!x))]
  if (!roleNames.length) return empty

  // 2) Role Profile -> department + hq (territory)
  const rps = (await getList('Role Profile', {
    filters: [['name', 'in', roleNames]],
    fields: ['name', 'custom_department', 'custom_territory'],
  })) as unknown as RoleProfileRow[]
  const deptToRole: Record<string, LineMapping> = {}
  for (const rp of rps) {
    if (!rp.custom_department) continue
    deptToRole[rp.custom_department] = { custom_role_profile: rp.name, custom_hq: rp.custom_territory || '', custom_department: rp.custom_department }
  }
  const departments = Object.keys(deptToRole)
  if (!departments.length) return empty

  // 3) Item -> department (Item child table, "Products" group). One row per child
  //    line; group by item in JS. valid_to is text → string compare on YYYY-MM-DD.
  const filters: unknown[] = [
    ['Elbrit Department Table', 'elbrit_department', 'in', departments],
    ['Item', 'item_group', 'descendants of (inclusive)', 'Products'],
  ]
  if (items?.length) filters.push(['Item', 'name', 'in', items])
  const rows = (await getList('Item', {
    filters,
    fields: [
      'name',
      '`tabElbrit Department Table`.`elbrit_department` as dep',
      '`tabElbrit Department Table`.`valid_from` as valid_from',
      '`tabElbrit Department Table`.`valid_to` as valid_to',
    ],
  })) as ItemDepRow[]
  const valid = (r: ItemDepRow) => (!r.valid_from || r.valid_from <= date) && (!r.valid_to || r.valid_to >= date)

  const byItem: Record<string, Set<string>> = {}
  for (const r of rows) {
    if (!r.name || !r.dep || !valid(r)) continue
    ;(byItem[r.name] = byItem[r.name] || new Set()).add(r.dep)
  }

  const itemMap: Record<string, LineMapping> = {}
  const conflicts: Record<string, string[]> = {}
  for (const [item, deps] of Object.entries(byItem)) {
    const matched = [...deps].filter((d) => d in deptToRole)
    if (matched.length === 1) itemMap[item] = deptToRole[matched[0]]
    else if (matched.length > 1) conflicts[item] = matched
  }
  const unmapped = (items || []).filter((i) => !(i in itemMap) && !(i in conflicts))
  return { itemMap, conflicts, unmapped, departments }
}
