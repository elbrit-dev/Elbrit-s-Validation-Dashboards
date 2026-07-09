// ============================================================================
// MANUAL NOMENCLATURE ALIASES  (sheet name  →  canonical UAT name)
//
// Most sheet names match a UAT record automatically (case / spacing / dashes /
// "(8 PACKS)" are all ignored). These tables are for names that differ in
// WORDING and can't be matched by a rule — maintained from the mapping sheet.
//
// IMPORTANT: item alias keys are matched SPACE-PRESERVING (each run of
// punctuation/space becomes ONE space, uppercased). That keeps "2 5" (=2.5)
// distinct from "25", which a space-removing key would wrongly merge. So write
// the LEFT side the way it reads with dots turned into spaces, e.g.
// "BISOBRIT 2 5" for BISOBRIT 2.5. The RIGHT side is the target UAT name (it is
// itself normalized against the Item master, so minor punctuation is forgiven).
//
// HOW TO ADD: one line per pair — 'SHEET NAME' : 'UAT NAME',
// ============================================================================

// Sheet Product  →  UAT Item (item_group "Products")
export const ITEM_ALIASES: Record<string, string> = {
  'BISOBRIT 2 5': 'BISOBRIT 2.5',
  'BISOBRIT 25': 'BISOBRIT 2.5',
  'BISOBRIT T 25': 'BISOBRIT T 2.5',
  'BRITORVA CV': 'BRITORVA CV 10',
  'BRITVIT 30': 'BRITVIT',
  'BRITVOG 0 2': 'BRITVOG 0.2',
  'BRITVOG 0 3': 'BRITVOG 0.3',
  'BRITVOG 02': 'BRITVOG 0.2',
  'BRITVOG 03': 'BRITVOG 0.3',
  'BRITVOG M 02': 'BRITVOG M 0.2',
  'BRITVOG M 03': 'BRITVOG M 0.3',
  'C + ZD MAX': 'CZD MAX',
  "C FERT M 15 'S": 'C FERT M',
  'C FERT M 15 S': 'C FERT M',
  'C FERT-M': 'C FERT M',
  'C+ZD': 'CZD MAX',
  'C+ZD MAX': 'CZD MAX',
  'CARTITAB UC CAPSULES': 'CARTITAB UC',
  'CHLORVIX 12 5': 'CHLORVIX 12.5',
  'CHLORVIX 125': 'CHLORVIX 12.5',
  'CHLORVIX 625': 'CHLORVIX 6.25',
  'CILNITAB NB 1025': 'CILNITAB NB 10/2.5',
  'CILNITAB NB 105': 'CILNITAB NB 10/5',
  'CILNITAB NB 10/25': 'CILNITAB NB 10/2.5',
  "CITIBRIT PLUS 10 'S": 'CITIBRIT PLUS',
  'CITIBRIT PLUS 10 S': 'CITIBRIT PLUS',
  'DROXIT': 'DROXIT 10',
  'ELBRIT C+ZD': 'CZD MAX',
  'ELBRIT CZD': 'CZD MAX',
  "EXIPAM PLUS 15 'S": 'EXIPAM PLUS',
  'EXIPAM PLUS 15 S': 'EXIPAM PLUS',
  'FENZIT 600 SG CAP': 'FENZIT 600',
  'GLIMIBRIT M 05': 'GLIMIBRIT M 0.5',
  'LINATO M 25500': 'LINATO M 2.5/500',
  'LINATO M 25/500': 'LINATO M 2.5/500',
  "MY 20 10 'S": 'MY GUT',
  'MY 20 10 S': 'MY GUT',
  "MY GUT 10 'S": 'MY GUT',
  'MY MAG': 'MYMAG',
  'MY WASH': 'MYWASH 100 ML',
  "MYCISS 10 'S": 'MYCISS PLUS',
  "MYCISS 10 S':": 'MYCISS PLUS',
  'MYWASH': 'MYWASH 100 ML',
  'NEBILOC 2 5': 'NEBILOC 2.5',
  'NEBILOC 25': 'NEBILOC 2.5',
  'NIG CR 26': 'NIG CR 2.6',
  'PREGABRIT D 5020': 'PREGABRIT D 50/20',
  'PREGABRITNT': 'PREGABRIT NT',
  'SITADOC M 50 1000': 'SITADOC M 50 / 1000',
  'SITADOC M 50 500': 'SITADOC M 50 / 500',
  "TELBRIT 80 15 'S": 'TELBRIT 80',
  'TELBRIT 80 15 S': 'TELBRIT 80',
  "TELBRIT AM 15 'S": 'TELBRIT AM',
  'TELBRIT AM 15 S': 'TELBRIT AM',
  'TELBRIT NB 4025': 'TELBRIT NB 40/2.5',
  'TELBRIT NB 405': 'TELBRIT NB 40/5',
  'TELBRIT NB 40/25': 'TELBRIT NB 40/2.5',
  'TRIGLIMIBRIT 1 3': 'TRIGLIMIBRIT 1.3',
  'TRIGLIMIBRIT 13': 'TRIGLIMIBRIT 1.3',
  'TRIGLIMIBRIT 2 3': 'TRIGLIMIBRIT 2.3',
  'TRIGLIMIBRIT 23': 'TRIGLIMIBRIT 2.3',
}

// Sheet Stockist  →  UAT Customer (for when we resolve the distributor link)
export const CUSTOMER_ALIASES: Record<string, string> = {
  // 'AROGYA MEDICAL AND SURGICAL AGENCIES': 'Arogya Medical & Surgical Agencies',
}
