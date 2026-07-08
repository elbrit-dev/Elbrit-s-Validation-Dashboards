# Secondary Data Entry Dashboard

Enters and validates monthly **secondary sales sheets** (Google Drive) against **ERPNext UAT** —
create / update / delete triage with batched runs, plus a data-quality validation view.
Built for big sessions: ~10,000 rows per monthly sheet, 2–3 sheets multi-selected at once (20–30k rows).

**Stack:** Next.js 15 · React 19 · TypeScript · Dexie (IndexedDB) · TanStack Table + Virtual · SheetJS · Netlify.

> ⚠ **Field mapping is a placeholder** (doctor-validation fields). The real secondary-sales
> doctype/columns swap in later by editing only:
> `lib/shared/mapping.ts` · `lib/shared/rowKey.ts` · `lib/validation/rules.ts`

## Quick start

```bash
npm install
cp .env.example .env   # fill in ERPNext UAT + Google Drive credentials
npm run dev            # http://localhost:5190
```

## How it handles 20–30k rows on Netlify (no database)

| Problem at scale | What this app does |
|---|---|
| File downloads blow the ~6 MB function body cap | `/api/drive/token` mints a short-lived read-only token; the **browser downloads sheets directly from Google** |
| Parsing 30k rows freezes the page | SheetJS runs in a **Web Worker**; rows stream into IndexedDB in 2k chunks |
| localStorage ~5 MB quota loses the session | **Dexie / IndexedDB** stores rows, ERP index and per-row run results — reload and resume |
| Serverless 10 s timeout kills big requests | Client-driven loops send **≤40–90 row slices**; write handlers keep an **8 s soft deadline** and return unfinished rows as `pending` for re-slicing |
| Tables can't render 30k rows | **Virtualized tables** everywhere (~40 DOM rows regardless of data size) |
| Re-fetching the ERP index every batch | Index fetched **once per session** (chunked lookup), cached in IndexedDB |

## Flow

1. **Entry → Drive sheets** — multi-select 2–3 monthly files; each gets a month tag (auto-guessed from the filename, editable).
2. **Check with UAT** — chunked lookup builds the ERP index, then a worker triages every row: `create` / `update` (with the changed-field list) / `unchanged` / `conflict` (duplicate code in the sheets).
3. **Run to UAT** — batched create + update with progress, pause/stop, automatic retry; already-written rows are skipped on re-run.
4. **Delete zone** (gated) — scans UAT for records missing from the loaded sheets; requires typing `DELETE`.
5. **Validation** — severity-weighted rule engine (error 25 / warning 8 / info 2), KPI cards, per-check distribution, filterable table, drilldown, Excel export.

## Env vars (`.env`, and Netlify UI for deploys)

`ERPNEXT_URL` · `ERPNEXT_API_KEY` · `ERPNEXT_API_SECRET` ·
`GOOGLE_SERVICE_ACCOUNT_JSON` (or `GOOGLE_DRIVE_API_KEY`) · `GOOGLE_DRIVE_FOLDER_ID`

None are exposed to the browser; the Drive token route returns only a minted read-only access token.

## Deploy (Netlify)

Connect the repo — `netlify.toml` already configures `@netlify/plugin-nextjs` and Node 22.
Set the env vars in Site settings → Environment variables.
