// ============================================================================
// MANUAL NOMENCLATURE ALIASES  (sheet name  →  canonical UAT name)
//
// Most sheet names match a UAT record automatically (case / spacing / dashes /
// "(8 PACKS)" are all ignored). Use these tables ONLY for names that differ in
// WORDING and can't be matched by a rule — e.g. the sheet says "ELBRIT C+ZD"
// but the real UAT item is "C+ZD MAX".
//
// HOW TO ADD (this is the one place to edit — nothing else changes):
//   'SHEET NAME AS IT APPEARS' : 'EXACT UAT NAME',
// Matching ignores case, spaces, dashes, dots and "(...)" notes on the LEFT
// side, so you don't have to be exact there. The RIGHT side should be the real
// UAT record name. Drop the trailing " ..." — it's stripped automatically.
// ============================================================================

// Sheet Product  →  UAT Item (item_group "Products")
export const ITEM_ALIASES: Record<string, string> = {
  'ELBRIT C+ZD': 'C+ZD MAX',
  // 'BRITORVA CV': 'BRITORVA CV 10',   // ← example: pick the right strength, then uncomment
}

// Sheet Stockist  →  UAT Customer (for when we resolve the distributor link)
export const CUSTOMER_ALIASES: Record<string, string> = {
  // 'AROGYA MEDICAL AND SURGICAL AGENCIES': 'Arogya Medical & Surgical Agencies',
}
