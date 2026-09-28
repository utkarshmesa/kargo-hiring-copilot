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
npm run db:seed              # creates the first pool "PM/SPM Q4 2026"
npm run dev                  # http://localhost:3000, log in with ADMIN_PASSWORD
```

### Supabase

1. Create a project in region **South Asia (Mumbai)**.
2. Project Settings → Database → Connection string:
   - "Transaction pooler" (port 6543) → `DATABASE_URL`
   - "Session pooler" (port 5432) → `DATABASE_URL_DIRECT`
3. Project Settings → API → `SUPABASE_URL` and the `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`.
4. Migrations enable row-level security on every table with no policies, so Supabase's public REST API exposes nothing.
   The app connects as the `postgres` role and is unaffected.

## Scripts

| Command | What |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run lint` | ESLint. Importing `resend` outside `lib/email/send.ts`, or `@google/genai` outside `lib/gemini/`, is an error |
| `npm run typecheck` | Route types + `tsc --noEmit` |
| `npm test` | Vitest: unit tests and database tests on in-memory Postgres (PGlite), no network |
| `npm run db:generate` | New migration from `lib/db/schema.ts` |
| `npm run db:migrate` | Apply migrations |
| `npm run db:seed` | Create the first pool if none exists |
| `npm run calibrate` | *(Phase 2)* the go-live gate |
| `npm run regress` | *(Phase 2)* live Gemini run on the B1–B12 synthetic CVs |

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
4. Run `npm run db:migrate` and `npm run db:seed` locally against the production database.

## Build status

| Phase | Scope | Status |
|---|---|---|
| 0 | Repo, Next.js, schema, config, auth, `vercel.json` | done |
| 1 | Upload, parse and guard, Extractor, redact and verify | — |
| 2 | Scorer ×3, rank, tiers, flags, Writer, calibrate | — |
| 3 | Shortlist, Pipeline, candidate card, CV viewer | — |
| 4 | Decisions, send guard, Resend, undo, webhooks | — |
| 5 | Cron, E2E, hardening | — |
