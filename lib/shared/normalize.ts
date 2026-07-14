// Pure value normalizers, shared by client triage and server writes so both
// sides agree on what counts as "the same value". Ported from the doctor
// validation dashboard's reconcile engine.

export type NormKind = 'text' | 'name' | 'hq' | 'state' | 'phone' | 'pincode' | 'code' | 'num'

export const text = (v: unknown): string =>
  v == null ? '' : String(v).trim().replace(/\s+/g, ' ').toLowerCase()

// name: drop leading salutation so "Dr Srinivasan" == "Srinivasan"
export const name = (v: unknown): string =>
  text(v).replace(/^(dr|dr\.|mr|mr\.|mrs|mrs\.|ms|ms\.|prof|prof\.)\s+/i, '')

// HQ/territory: "Chennai" (sheet) vs "HQ-Chennai" (erp) -> strip leading "hq-"
export const hq = (v: unknown): string => text(v).replace(/^hq[-\s]*/i, '')

// state: ignore case + punctuation/spaces -> "TAMILNADU" == "Tamil Nadu"
export const state = (v: unknown): string => text(v).replace(/[^a-z0-9]/g, '')

// phone: digits only, last 10 (handles +91, spaces, placeholder "0")
export const phone = (v: unknown): string => {
  const d = String(v ?? '').replace(/\D/g, '')
  return d.length >= 10 ? d.slice(-10) : ''
}

export const pincode = (v: unknown): string => String(v ?? '').replace(/\D/g, '')

// code: strip leading zeros ("00078031" == "78031")
export const code = (v: unknown): string => String(v ?? '').trim().replace(/^0+/, '')

export const isBlank = (s: string): boolean => s === '' || s == null

// Parse a possibly-formatted number. Ecubix exports carry Indian thousands
// separators ("2,143", "83,684.15") and sometimes a currency symbol ("₹71.00").
// Bare parseFloat stops at the first comma — parseFloat("2,143") === 2 — so the
// magnitude was silently dropped (2143 written as 2, and every value-based check
// evaluated against the wrong number). Strip any grouping/currency chars first,
// keeping only digits, a single decimal point and a leading sign.
export function parseNum(v: unknown): number {
  const cleaned = String(v ?? '').replace(/[^0-9.\-]/g, '')
  const n = parseFloat(cleaned)
  return Number.isFinite(n) ? n : 0
}

// Lat/long: ~1e-3 ≈ 100 m — precision/rounding differences are not a change.
export const NUM_TOL = 1e-3

export function normalizeBy(kind: NormKind, v: unknown): string {
  switch (kind) {
    case 'name': return name(v)
    case 'hq': return hq(v)
    case 'state': return state(v)
    case 'phone': return phone(v)
    case 'pincode': return pincode(v)
    case 'code': return code(v)
    case 'num': {
      const n = parseNum(v)
      return n === 0 ? '' : String(n)
    }
    default: return text(v)
  }
}

// Equality under a norm kind. Numbers get tolerance; everything else compares
// the normalized strings.
export function sameValue(kind: NormKind, a: unknown, b: unknown): boolean {
  if (kind === 'num') {
    const x = parseNum(a)
    const y = parseNum(b)
    const xB = x === 0
    const yB = y === 0
    if (xB && yB) return true
    if (xB || yB) return false
    return Math.abs(x - y) <= NUM_TOL
  }
  return normalizeBy(kind, a) === normalizeBy(kind, b)
}
