// Row identity — the single source of truth for what makes a sheet row unique.
// For secondary sales the identity is the PARENT key (distributor + date): many
// product rows sharing the same distributor + date group into ONE Secondary
// Data Entry document. Change the key composition in lib/shared/mapping.ts.

import { parentKey, PARENT_FIELDS } from './mapping'

// The distributor column, reported purely for the UI's "code column" slot.
// Identity itself is distributor + date (see rowKey below).
export function detectCodeColumn(headers: string[]): string | null {
  for (const h of PARENT_FIELDS[0].sheet) {
    const hit = headers.find((x) => x.trim().toLowerCase() === h.toLowerCase())
    if (hit) return hit
  }
  return null
}

// The identity key for a parsed row. Empty string = row has no key (skipped /
// flagged): missing distributor or date.
export function rowKey(raw: Record<string, unknown>, _codeColumn: string, _monthTag: string): string {
  return parentKey(raw)
}
