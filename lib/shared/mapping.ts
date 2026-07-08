// ============================================================================
// ⚠ FIELD MAPPING — PLACEHOLDER (doctor-validation fields)
//
// This file is the SINGLE place that knows what the sheet columns are, which
// ERPNext doctype/fields they map to, and what identifies a row. Per the plan,
// the secondary-sales fields are different and will be swapped in later: when
// the real sheet arrives, edit THIS file (+ lib/shared/rowKey.ts and
// lib/validation/rules.ts) and nothing else changes.
// ============================================================================

import type { NormKind } from './normalize'

// Target ERPNext doctype and how records are keyed.
export const DOCTYPE = 'Lead'
export const RECORD_LABEL = 'Record'
export const CODE_FIELD = 'custom_doctor_code' // ERP field carrying the sheet code
export const NAME_PREFIX = 'DR-'               // document name = DR-<code>
// Is the doctype submittable? Submittable docs need cancel before delete.
export const SUBMITTABLE = false

// How to find the code column in the sheet (first pattern that matches wins).
export const CODE_COLUMN_PATTERNS: RegExp[] = [/^dr\.?\s*code$/i, /code/i]

export interface FieldMap {
  key: string
  label: string
  /** Sheet column header(s). An array means the columns join into one value. */
  sheet: string | string[]
  /** ERPNext fieldname on the doctype. */
  erp: string
  norm: NormKind
  /** Only written on create, never diffed for updates. */
  createOnly?: boolean
}

export const FIELD_MAP: FieldMap[] = [
  { key: 'name',          label: 'Name',          sheet: 'Dr. Name',                 erp: 'first_name',           norm: 'name' },
  { key: 'qualification', label: 'Qualification', sheet: 'Qualification',            erp: 'custom_qualification', norm: 'text' },
  { key: 'specialty',     label: 'Speciality',    sheet: 'Speciality',               erp: 'custom_speciality',    norm: 'text' },
  { key: 'category',      label: 'Category',      sheet: 'Category',                 erp: 'custom_category',      norm: 'text' },
  { key: 'territory',     label: 'HQ → Territory', sheet: 'HQ',                      erp: 'territory',            norm: 'hq' },
  { key: 'state',         label: 'State',         sheet: 'State',                    erp: 'state',                norm: 'state' },
  { key: 'city',          label: 'City',          sheet: 'Dr. City (Clinic)',        erp: 'city',                 norm: 'text' },
  { key: 'mobile',        label: 'Mobile',        sheet: 'Mobile No.',               erp: 'mobile_no',            norm: 'phone' },
  { key: 'latitude',      label: 'Latitude',      sheet: 'Standardize Latitude 1',   erp: 'custom_latitude',      norm: 'num' },
  { key: 'longitude',     label: 'Longitude',     sheet: 'Standardize Longitude 1',  erp: 'custom_longitude',     norm: 'num' },
]

// Fields fetched from ERPNext for the lookup index (diff inputs + identity).
export const ERP_FETCH_FIELDS: string[] = ['name', CODE_FIELD, ...FIELD_MAP.map((f) => f.erp)]

// Read a field's sheet value, joining multiple columns into one when `sheet`
// is an array (e.g. an address split across 3 columns).
export function sheetValue(raw: Record<string, unknown>, sheet: string | string[]): string {
  if (Array.isArray(sheet)) {
    return sheet
      .map((k) => raw[k])
      .filter((v) => v != null && String(v).trim() !== '')
      .join(' ')
  }
  const v = raw[sheet]
  return v == null ? '' : String(v)
}

// Build the ERPNext field payload for a row (used by create; update sends the
// changed subset). Values are written verbatim from the sheet (trimmed).
export function erpPayload(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of FIELD_MAP) {
    const v = sheetValue(raw, f.sheet).trim()
    if (v !== '') out[f.erp] = v
  }
  return out
}
