// Row identity — the single source of truth for what makes a sheet row unique.
// ⚠ PLACEHOLDER (doctor fields): identity = the doctor code, so the same code
// in two monthly sheets targets ONE ERPNext record (and in-sheet duplicates are
// flagged as conflicts). For secondary sales the key will likely become
// distributor + product + customer + month — change it HERE only.

import { code } from './normalize'
import { CODE_COLUMN_PATTERNS } from './mapping'

// Find the code column among the sheet headers.
export function detectCodeColumn(headers: string[]): string | null {
  for (const pattern of CODE_COLUMN_PATTERNS) {
    const hit = headers.find((h) => pattern.test(h.trim()))
    if (hit) return hit
  }
  return null
}

// The identity key for a parsed row. Empty string = row has no key (skipped).
export function rowKey(raw: Record<string, unknown>, codeColumn: string, _monthTag: string): string {
  return code(raw[codeColumn])
}
