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
  'BRITVIT 10': 'BRITVIT',
  'CardiQ': 'CARDI Q',
  'MYGUT': 'MY GUT',
  'NIG C.R 6.4': 'NIG CR 6.4',
  'Calbrit 60k Sachet': 'CALBRIT 60K SACHET',
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
  'C + ZD MAX': 'C+ZD MAX',
  "C FERT M 15 'S": 'C FERT M',
  'C FERT M 15 S': 'C FERT M',
  'C FERT-M': 'C FERT M',
  'C+ZD': 'C+ZD MAX',
  'C+ZD MAX': 'C+ZD MAX',
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
  'ELBRIT C+ZD': 'C+ZD MAX',
  'ELBRIT CZD': 'C+ZD MAX',
  "EXIPAM PLUS 15 'S": 'EXIPAM PLUS',
  'EXIPAM PLUS 15 S': 'EXIPAM PLUS',
  'FENZIT 600 SG CAP': 'FENZIT 600',
  'GLIMIBRIT M 05': 'GLIMIBRIT M 0.5',
  'LINATO M 25500': 'LINATO M 2.5/500',
  'LINATO M 25/500': 'LINATO M 2.5/500',
  "MY 20 10 'S": 'MY20',
  'MY 20 10 S': 'MY20',
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

// Sheet Stockist  →  UAT Customer (distributor link). Left side is matched
// case/punctuation-insensitively.
//
// The RIGHT side is EITHER:
//   • an exact UAT Customer name  (e.g. 'Divya Pharma Distributors Pvt Ltd'), OR
//   • an EBS code  (e.g. 'EBS708')  — use this when several UAT customers share
//     the SAME name and only the EBS code (whg_ebs_code) tells them apart. The
//     Ecubix sheet always sends the bare name (e.g. "OPTIVAL HEALTH SOLUTIONS
//     PRIVATE LIMITED"), which would otherwise silently match the wrong record;
//     pinning to the EBS code resolves it to the exact customer + sales team.
//     EBS310=Chennai etc. — look up the code on the Customer in ERP.
export const CUSTOMER_ALIASES: Record<string, string> = {
  'DIVYA PHARMA DIST': 'Divya Pharma Distributors Pvt Ltd',
  'VENKATASAI AGENCIES DRUGS PVT LTD UPPAL': 'Venkatasai Agencies Drugs Pvt Ltd',
  'SRI VENKATESHWARA GALAXY MEDICAL DISTRIBUTORS PRIVATE': 'Sri Venkateswara Galaxy Medical Distributors Private Limited',
  'VARDHMAN MEDISALES PVT LTD MANGALORE': 'Vardhaman Medisales Pvt Ltd Mangalore',
  'AYUSH PHARMA': 'M/S Ayush Pharma',
  'GOPAL MEDICALS': 'M/S Gopal Medicales',
  'NEW JAISWAL MEDICOS': 'New Jaiswal Medicose',
  'D.P Medicose': 'D.P Medicos',
  'LUCKY PHARMA LOGISTICS PVT LTD': 'Lucky Pharma Logistics Private Limited',
  // Palepu Madurai is now pinned by its EBS Stockist Code (EBS107, the customer's
  // secondary "EBS Code" field) via the EBS logic — no name alias needed.
  'SRI SAROJINI ENTERPRISES': 'Sarojini Enterprises',
  'A M PHARMA': 'AM PHARMA',
  'M M PHARMA DISTRIBUTOR': 'M M Pharma Distributor',
  'M.M. PHARMA DISTRIBUTOR': 'M.M. Pharma Distributor',
  'PURANI HOSPITAL SUPPLIES PRIVATE LTD': 'EBS143', // pin to Purani … Cbe by EBS code
  'R.S.DRUGS AND MEDICALS PVT LTD': 'R.S. Drugs and Medicals Private Limited',
  'YOGIRAM HEALTHCARE': 'Yogiram Distributors Private Limited Anx',
  'PALEPU PHARMA PVT LTD TAMBARAM': 'Palepu Pharma Dist Pvt Ltd Tambaram',
  'SRI ANDAVAR': 'Sri Andavar Trichy Pharmaceuticals',
  'SRI SELVAGANESH MEDICALS AGENCIES': 'Sri Selva Ganesh Medicals Agencies',
  'DR.SUNDARARAJAN NEURO HOSPITAL PVT LTD': 'Dr Sundarajan Neuro Hospital Pvt Ltd',
  'SRI LAKSHMI MEDICAL CENTRE & HOSPITAL': 'Sri Lakshmi Medical Centre  &  Hospital Pharmacy',
  'OPTIVAL HEALTH SOLUTIONS PVT LTD': 'Optival Health Solutions Private Limited',
  // Ecubix sends the bare name for all 3 Optival records; pin to the exact one by
  // EBS code (EBS709 = KA/HQ-Bangalore). Flip to EBS708 (AP/Vijayawada) or EBS710
  // (Chennai) if this sheet's Optival is a different branch.
  'OPTIVAL HEALTH SOLUTIONS PRIVATE LIMITED': 'EBS709',
  'PALEPU PHARMA DIST PVT LTD MYLAPORE': 'Palepu Pharma Distributors Pvt Ltd Mylapore',
  'SURESH PHARMA AGENCIES CH PVT LTD': 'Suresh Pharma Agencies (Chennai) Private Limited',
  'PURANI HOSPITAL SUPPLIES LTD': 'EBS207', // pin to Purani … Erd by EBS code
  'SENTHILMURUGAN MEDICAL': 'Senthilmurugan Medical Agences',
  'SENTHILMURUGAN MEDICAL AGENCIES': 'Senthilmurugan Medical Agences',
  'PALEPU PHARMA PVT.LTD.': 'Palepu Pharma Private Ltd - Chennai',
  'MUTHU PHARMA PRIVATE LIMITED': 'Muthu Pharma - A Unit Of Ascent Wellness',
  'LIFECARE PHARMACEUTICALS': 'Lifecare Pharma Private Limited',
  'AJ ASSOCIATES': 'A J Associates',
  'DEVI PHARMA WELLNESS PVT LTD': 'Devi Pharma Wellness Private Limited',
  'WESTERN HEALTHCARE SOLUTIONS PVT LTD': 'Western Healthcare Solutions Private Limited',
  'MEDIHAUXE PHARMACEUTICALS PVT LTD': 'Medihauxe Pharmaceuticals Private Limited',
  'KHANDELWAL MEDICOSE': 'M/S Khandelwal Medicos',
  'VRINDAVAN PHARMA': 'M/S Vrindavan Pharma',
  'M KUMARS DISTRIBUTORS': "M Kumar'S Distributors",
}
