# Kargo Hiring Copilot

AI-assisted CV screening and candidate communication for Kargo's Product Manager and Senior Product Manager roles.
The system reads, redacts, scores, explains and recommends. **Arjun decides.** No candidate is emailed without his decision.

Source documents (precedence: rubric > PRD > map):

- [`docs/kargo_hiring_rubric.md`](docs/kargo_hiring_rubric.md): the scoring source of truth
- [`docs/PRD.md`](docs/PRD.md): what gets built
- [`docs/components_map_v3.md`](docs/components_map_v3.md): the 13-step architecture

## Stack

Next.js 16 (App Router, TypeScript strict) on Vercel (`bom1`) · Supabase Postgres (Mumbai) with Drizzle ORM ·
Supabase Storage (private bucket) · Vercel Cron · Gemini (`@google/genai`) · Resend.

Deviations from the PRD, agreed during planning:

| PRD | Here | Why |
|---|---|---|
| Vercel Postgres (Neon) | Supabase Postgres | Supabase has a Mumbai region, next to the `bom1` functions; free tier |
| Vercel Blob | Supabase Storage, private bucket | One vendor for data and files; one upload path (signed URL + register) |
| Temperature 0 | Temperature 1.0 + fixed seed | Google's guidance for Gemini 3: values below 1.0 can cause looping. The 3-run median absorbs variance |
| — | `EMAIL_REDIRECT_TO` | Test CVs contain real-looking addresses; every candidate email goes to the redirect address until go-live |

## Local setup

Requirements: Node 24, npm.

```bash
npm install
cp .env.example .env.local   # then fill in values
npm run db:migrate           # applies drizzle/ migrations (needs DATABASE_URL_DIRECT)
npm run dev                  # http://localhost:3000, log in with ADMIN_PASSWORD
```

### Supabase

1. Create a project in region **South Asia (Mumbai)**.
2. Project Settings → Database → Connection string:
   - "Transaction pooler" (port 6543) → `DATABASE_URL`
   - "Session pooler" (port 5432) → `DATABASE_URL_DIRECT`
3. Project Settings → API → `SUPABASE_URL` and the `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`.
4. The private Storage bucket `cvs` is created automatically on the first upload (the app refuses to run if it is public).
5. Migrations enable row-level security on every table with no policies, so Supabase's public REST API exposes nothing.
   The app connects as the `postgres` role and is unaffected.

## How a CV is processed (so far)

1. The browser asks `/api/upload/token` for a signed URL, uploads the file straight to the private bucket, then calls `/api/upload/register` (status `queued`).
2. The Upload page calls `/api/process-next` in a loop (`GEMINI_CONCURRENCY` at a time). Each call claims one CV with a single SQL statement and a lease.
3. Parse (DOCX hidden/white text stripped, injection lines removed) → under 150 words is tier R `unparseable`.
4. Gemini Extractor splits the CV (the raw output is stored only in `candidates.extractor_json`) → fidelity check (every bullet exact, ≥ 60% coverage; one retry) → identity split, record key, duplicates, `NO_CONTACT`, eligibility.
5. Code redaction → leak check. Any leak is tier R `redaction_leak` and the profile is **not** stored.
6. Until calibration passes, a redacted CV waits in `queued` ("waiting for calibration").
7. Scorer ×3 (parallel, fresh calls, thinking high). Raw runs are stored before anything else.
8. Rank in code: per-run quote check → section cap → median / spread → reuse limit; D7 from experience computed from raw dates; totals, tier and flags from the pool config.
9. Writer brief from verified quotes only; probes and the invite line are checked in code for forbidden topics.

## Calibration (the go-live gate)

```bash
npm run calibrate
```

- Runs `calibration/*.docx` blind through Steps 2–8. Labels and join dates live in `calibration/labels.json`; the join date is each CV's as-of date for "Present".
- **PASS** = every "Exceeds" hire's core score (D1–D6) is higher than every "Meets"/"Below" hire's.
- The result is written to `calibrations` with the rubric hash, the pool config hash and the model ID. `/api/process-next` refuses to score (HTTP 409, amber banner) until a passing row matches all three. Changing the rubric, a pool weight or `GEMINI_MODEL` closes the gate until you re-run it.
- A failing run prints dimension-level differences against Appendix A. Weights and anchors are never adjusted automatically.
- Full per-run output is saved to `calibration/results/` (gitignored).

## Model settings

`GEMINI_MODEL` must be a stable pinned ID. Every call uses a JSON response schema, temperature 1.0 (Google's guidance for Gemini 3) with a fixed seed, and an explicit thinking level: low for the Extractor and Writer, high for the Scorer.

## Scripts

| Command | What |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run lint` | ESLint. Importing `resend` outside `lib/email/send.ts`, or `@google/genai` outside `lib/gemini/`, is an error |
| `npm run typecheck` | Route types + `tsc --noEmit` |
| `npm test` | Vitest: unit tests and database tests on in-memory Postgres (PGlite), no network |
| `npm run db:generate` | New migration from `lib/db/schema.ts` |
| `npm run db:migrate` | Apply migrations |
| `npm run preview -- <files>` | Steps 2–5 on local files (parse, Extractor, redaction, leak check) with live Gemini and no database; prints the redacted profiles |
| `npm run calibrate` | The go-live gate: the 8 past hires through the full pipeline, live. Prints scores next to rubric Appendix A and PASS/FAIL; records the result in `calibrations` when `DATABASE_URL` is set |
| `npm run regress [B1 B7 …]` | The B1–B12 synthetic CVs through live Gemini: expected tier ±1 and flags |
| `npm run check:storage` | Verifies the private CV bucket (signed upload, download, no public access, delete) |

## Environment variables

See [`.env.example`](.env.example) for every variable with a description. PRD Appendix C, adjusted for Supabase:
`BLOB_READ_WRITE_TOKEN` and `FILE_ENC_KEY` are replaced by `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, and
`DATABASE_URL_DIRECT` and `EMAIL_REDIRECT_TO` are added.

## Deploy (Vercel)

1. Push the repo to GitHub and import it in Vercel.
2. Add every variable from `.env.example` under Project → Settings → Environment Variables (Production).
   Set `APP_URL` to the production URL.
3. `vercel.json` pins functions to `bom1` and schedules the daily cron at 03:30 UTC (09:00 IST).
   On the Hobby plan the cron fires once a day, anywhere within that hour.
4. Run `npm run db:migrate` locally against the production database. The first pool, "PM/SPM Q4 2026", is created on first use.

## Build status

| Phase | Scope | Status |
|---|---|---|
| 0 | Repo, Next.js, schema, config, auth, `vercel.json` | done |
| 1 | Upload, parse and guard, Extractor, redact and verify | done (awaiting Supabase for the live upload demo) |
| 2 | Scorer ×3, rank, tiers, flags, Writer, calibrate | done: calibrate PASS (margin 26.3); recording the pass needs DATABASE_URL |
| 3 | Shortlist, Pipeline, candidate card, CV viewer | — |
| 4 | Decisions, send guard, Resend, undo, webhooks | — |
| 5 | Cron, E2E, hardening | — |
