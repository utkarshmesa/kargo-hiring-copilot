import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { PoolConfig } from "./config/defaults";
import { weeksLeft } from "./dates";
import type { Db } from "./db/client";
import { candidates, decisions, emails, evaluations, pools } from "./db/schema";
import { sendDigest, sendForDecision, syncPastDueEmails, type ResendLike } from "./email/send";
import { log } from "./log";
import { removeFiles } from "./storage";

// PRD Step 13: the daily cron. Every job is idempotent: Vercel cron delivery is
// best-effort and can repeat, so running twice must never send twice or break data.

type Deps = { db: Db; resend?: ResendLike; now?: () => Date };

/** Today's date in India (the digest and Hold dates are Arjun's calendar days). */
export function istDate(d: Date): string {
  return new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

const nameOf = (c: { displayName: string | null; fileName: string | null }) => c.displayName ?? c.fileName ?? "a candidate";

// 1. Emails whose webhook we missed: ask Resend, then flag bounces.
export async function reconcileEmails(deps: Deps): Promise<number> {
  const n = await syncPastDueEmails(deps);
  await deps.db.execute(sql`
    UPDATE evaluations e SET flags = array(select distinct unnest(e.flags || ARRAY['BOUNCED']::text[]))
    WHERE NOT ('BOUNCED' = ANY(e.flags)) AND EXISTS (SELECT 1 FROM emails m WHERE m.evaluation_id = e.id AND m.status = 'bounced')`);
  return n;
}

// 2. One nudge to candidates Advanced, not Booked, ≥ nudgeAfterDays since the invite went out.
export async function sendNudges(deps: Deps): Promise<number> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const rows = await db
    .select({ d: decisions, ev: evaluations, pool: pools, invite: emails })
    .from(decisions)
    .innerJoin(evaluations, eq(evaluations.id, decisions.evaluationId))
    .innerJoin(pools, eq(pools.id, evaluations.poolId))
    .innerJoin(emails, and(eq(emails.decisionId, decisions.id), eq(emails.kind, "advance")))
    .where(and(eq(decisions.action, "advance"), isNull(decisions.undoneAt), eq(evaluations.pipelineStatus, "advanced"), inArray(emails.status, ["sent", "delivered"])));
  let sent = 0;
  for (const { d, pool, invite } of rows) {
    const days = (pool.configJson as PoolConfig).nudgeAfterDays;
    const invitedAt = invite.scheduledAt ?? invite.createdAt;
    if (now.getTime() - invitedAt.getTime() < days * 86_400_000) continue;
    const r = await sendForDecision(d.id, "nudge", deps);
    if (r.ok) sent++; // "already_sent" on a repeat run: exactly one nudge, ever
  }
  return sent;
}

// 3 + B.6. Arjun's digest, with Holds due today at the top.
export async function sendDailyDigest(deps: Deps) {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const today = istDate(now);
  const [pool] = await db.select().from(pools).orderBy(sql`${pools.createdAt} desc`).limit(1);
  if (!pool) return { ok: false as const, reason: "no pool" };
  const config = pool.configJson as PoolConfig;
  const rows = await db
    .select({ ev: evaluations, cand: candidates })
    .from(evaluations)
    .innerJoin(candidates, eq(candidates.id, evaluations.candidateId))
    .where(eq(evaluations.poolId, pool.id));

  const waiting = rows.filter((r) => (r.ev.status === "scored" || r.ev.status === "needs_review") && (r.ev.pipelineStatus ?? "scored") === "scored");
  const oldestDays = waiting.reduce((m, r) => Math.max(m, Math.floor((now.getTime() - (r.ev.pipelineStatusAt ?? r.ev.createdAt).getTime()) / 86_400_000)), 0);

  const holds = await db
    .select({ holdUntil: decisions.holdUntil, evaluationId: decisions.evaluationId })
    .from(decisions)
    .innerJoin(evaluations, eq(evaluations.id, decisions.evaluationId))
    .where(and(eq(decisions.action, "hold"), isNull(decisions.undoneAt), eq(evaluations.pipelineStatus, "hold"), lte(decisions.holdUntil, today)));
  const byEval = new Map(rows.map((r) => [r.ev.id, r]));
  const holdsDue = [...new Set(holds.map((h) => h.evaluationId))].map((id) => nameOf(byEval.get(id)!.cand));

  const nudged = new Set(
    (await db.select({ evaluationId: emails.evaluationId }).from(emails).where(and(eq(emails.kind, "nudge"), inArray(emails.status, ["sent", "delivered"])))).map((e) => e.evaluationId),
  );
  const status = (s: string) => rows.filter((r) => r.ev.pipelineStatus === s);
  const data = {
    nWaiting: waiting.length,
    oldestDays,
    dashboardUrl: (process.env.APP_URL ?? "").replace(/\/$/, ""),
    weeksLeft: weeksLeft(config.offerTargetDate, now),
    holdsDue,
    interviewedStale: status("interviewed").map((r) => nameOf(r.cand)),
    notBooked: status("advanced").map((r) => `${nameOf(r.cand)}${nudged.has(r.ev.id) ? " (nudged)" : ""}`),
    bounced: rows.filter((r) => r.ev.flags.includes("BOUNCED")).map((r) => nameOf(r.cand)),
    counts: { advanced: status("advanced").length, booked: status("booked").length, interviewed: status("interviewed").length, offer: status("offer").length },
  };
  return sendDigest(today, data, deps);
}

// 4. Drain what the dashboard left: one HTTP call to /api/process-next per CV, so each
// CV still gets its own function invocation (PRD §8.2).
export async function drainQueue(opts: { appUrl: string; cronSecret: string; budgetMs: number; concurrency: number }): Promise<number> {
  const deadline = Date.now() + opts.budgetMs;
  let processed = 0;
  const worker = async () => {
    while (Date.now() < deadline) {
      const res = await fetch(`${opts.appUrl.replace(/\/$/, "")}/api/process-next`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.cronSecret}` },
      }).catch(() => null);
      const body = res ? await res.json().catch(() => ({})) : {};
      if (!body.processed) return;
      processed++;
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency }, worker));
  return processed;
}

// 5. Retention (rubric §13, PRD Step 13): retentionDays after a pool closes, delete CV
// files and identity; strip all CV-derived text. Numeric scores, tiers, flags, hashes and
// decisions (without free text) are kept for calibration.
export async function applyRetention(deps: Deps & { remove?: (paths: string[]) => Promise<void> }): Promise<number> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const remove = deps.remove ?? removeFiles;
  const closed = await db.select().from(pools).where(sql`${pools.closedAt} IS NOT NULL`);
  let purged = 0;
  for (const pool of closed) {
    const days = (pool.configJson as PoolConfig).retentionDays;
    if (now.getTime() - pool.closedAt!.getTime() < days * 86_400_000) continue;
    const evs = await db
      .select({ ev: evaluations, cand: candidates })
      .from(evaluations)
      .innerJoin(candidates, eq(candidates.id, evaluations.candidateId))
      .where(and(eq(evaluations.poolId, pool.id), isNull(candidates.deletedAt)));
    for (const { ev, cand } of evs) {
      if (ev.filePath) await remove([ev.filePath]);
      await db
        .update(evaluations)
        .set({
          filePath: null,
          redactedProfileText: null,
          redactedProfileJson: null,
          briefJson: null,
          dimsFinalJson: stripDims(ev.dimsFinalJson),
          runScoresJson: stripRuns(ev.runScoresJson),
          experienceJson: stripExperience(ev.experienceJson),
          lastError: null,
        })
        .where(eq(evaluations.id, ev.id));
      await db.update(decisions).set({ reason: null, inviteLineFinal: null }).where(eq(decisions.evaluationId, ev.id));
      await db
        .update(candidates)
        .set({
          displayName: null,
          email: null,
          phone: null,
          urls: [],
          fileName: null,
          extractorJson: null,
          parseLogJson: null,
          recordKey: null,
          linkedCandidateIds: [],
          deletedAt: now,
        })
        .where(eq(candidates.id, cand.id));
      purged++;
    }
  }
  if (purged) log("retention.purged", { purged });
  return purged;
}

type AnyJson = Record<string, unknown> | null;
function stripDims(j: unknown): AnyJson {
  const v = j as { dims?: Record<string, Record<string, unknown>>; d7?: unknown; roleUsed?: unknown } | null;
  if (!v?.dims) return null;
  const dims = Object.fromEntries(
    Object.entries(v.dims).map(([k, d]) => [k, { id: d.id, score: d.score, runScores: d.runScores, evidence_status: d.evidence_status, confidence: d.confidence, quoteMismatch: d.quoteMismatch }]),
  );
  return { dims, d7: v.d7, roleUsed: v.roleUsed };
}
function stripRuns(j: unknown): AnyJson {
  const v = j as { runs?: { dimensions: Record<string, { score: number; evidence_status: string; confidence: string }> }[]; modelId?: string } | null;
  if (!v?.runs) return null;
  return {
    modelId: v.modelId,
    runs: v.runs.map((r) => ({ dimensions: Object.fromEntries(Object.entries(r.dimensions).map(([k, d]) => [k, { score: d.score, evidence_status: d.evidence_status, confidence: d.confidence }])) })),
  };
}
function stripExperience(j: unknown): AnyJson {
  const v = j as { pmRelevantYears?: number; roles?: { roleIndex: number; type: string; months: number | null; rate: number }[] } | null;
  if (!v) return null;
  return { pmRelevantYears: v.pmRelevantYears, roles: (v.roles ?? []).map((r) => ({ roleIndex: r.roleIndex, type: r.type, months: r.months, rate: r.rate })) };
}
