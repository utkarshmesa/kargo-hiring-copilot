import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { candidates, evaluations, pools } from "@/lib/db/schema";
import { InvalidOutputError, TransientGeminiError } from "@/lib/gemini/client";
import type { ExtractorOutput } from "@/lib/gemini/extractor";
import type { ScorerRun } from "@/lib/gemini/scorer";
import { poolConfig } from "@/lib/pools";
import { eligibility, recordKey } from "@/lib/redact/identity";
import type { RedactedProfileJson } from "@/lib/redact/profile";
import { rubricHash } from "@/lib/rubric";
import { log } from "@/lib/log";
import { prepareProfile, type Extract } from "./prepare";
import { rankRuns, scoreRuns, writerEvidence, type Score, type ScoreContext, type Write } from "./score";

// One evaluation, one invocation (PRD §8.2). Each stage's output is stored before the
// next stage runs, so a retry resumes where it stopped instead of re-calling Gemini:
// extractor_json → redacted profile → raw Scorer runs → brief.

export const MAX_ATTEMPTS = 3;
export const MAX_TRANSIENT_RETRIES = 8;

export type Deps = {
  db: Db;
  download: (path: string) => Promise<Uint8Array>;
  extract: Extract;
  score: Score;
  write: Write;
  modelId: string;
  /** False while the calibration gate is closed: CVs are prepared but never scored. */
  allowScoring: boolean;
  now?: () => Date;
};

type Outcome = "prepared" | "scored" | "needs_review" | "requeued" | "failed";

export async function processEvaluation(id: string, deps: Deps): Promise<Outcome> {
  const { db } = deps;
  const [first] = await db.select().from(evaluations).where(eq(evaluations.id, id));
  if (!first) throw new Error("evaluation not found");
  try {
    if (!first.redactedProfileText) {
      const prepared = await prepareStage(first, deps);
      if (prepared !== "prepared") return prepared;
    }
    if (!deps.allowScoring) {
      await db.update(evaluations).set({ status: "queued", claimedAt: null }).where(eq(evaluations.id, id));
      return "prepared";
    }
    return await scoreStage(id, deps);
  } catch (err) {
    return handleError(deps, first, err);
  }
}

async function scoreStage(id: string, deps: Deps): Promise<Outcome> {
  const { db } = deps;
  const [ev] = await db.select().from(evaluations).where(eq(evaluations.id, id));
  const [cand] = await db.select().from(candidates).where(eq(candidates.id, ev.candidateId));
  const [pool] = await db.select().from(pools).where(eq(pools.id, ev.poolId));
  const config = poolConfig(pool);
  const ctx: ScoreContext = {
    profileText: ev.redactedProfileText!,
    profileJson: ev.redactedProfileJson as RedactedProfileJson,
    extractor: cand.extractorJson as ExtractorOutput,
    asOf: ev.createdAt,
    roleApplied: ev.roleApplied,
    config,
  };

  // Raw runs are stored first: totals and tiers are always recomputable from them.
  let stored = ev.runScoresJson as { runs: ScorerRun[]; modelId: string } | null;
  if (!stored) {
    stored = { runs: await scoreRuns(ctx, deps.score), modelId: deps.modelId };
    await db.update(evaluations).set({ runScoresJson: stored, modelId: deps.modelId }).where(eq(evaluations.id, id));
  }
  const r = rankRuns(ctx, stored.runs);

  let brief: unknown = null;
  try {
    brief = await deps.write(writerEvidence(r, config));
  } catch (err) {
    if (!(err instanceof InvalidOutputError)) throw err; // transient: requeue, runs are kept
    brief = null; // shown as "brief unavailable"
  }

  const flags = [...new Set([...ev.flags, ...r.flags])];
  const now = deps.now?.() ?? new Date();
  await db
    .update(evaluations)
    .set({
      status: r.tier === "R" ? "needs_review" : "scored",
      claimedAt: null,
      dimsFinalJson: { dims: r.dims, d7: r.d7, qualifiers: r.qualifiers, roleUsed: r.roleUsed },
      experienceJson: r.experience,
      pmTotal: r.pmTotal,
      spmTotal: r.spmTotal,
      coreScore: r.coreScore,
      bestFitRole: r.bestFitRole,
      tier: r.tier,
      tierReason: r.tierReason,
      flags,
      briefJson: brief,
      modelId: stored.modelId,
      rubricHash: rubricHash(),
      configHash: pool.configHash,
      pipelineStatus: ev.pipelineStatus ?? "scored",
      pipelineStatusAt: ev.pipelineStatusAt ?? now,
      scoredAt: now,
      lastError: null,
    })
    .where(eq(evaluations.id, id));
  log("evaluation.scored", { id, tier: r.tier });
  return r.tier === "R" ? "needs_review" : "scored";
}

async function prepareStage(ev: typeof evaluations.$inferSelect, deps: Deps): Promise<Outcome> {
  const { db } = deps;
  const id = ev.id;
  const [cand] = await db.select().from(candidates).where(eq(candidates.id, ev.candidateId));
  {
    if (!ev.filePath) throw new Error("evaluation has no file");

    const bytes = await deps.download(ev.filePath);
    const flags = new Set<string>(ev.flags);
    if (cand.legacy) flags.add("LEGACY");

    const result = await prepareProfile({
      bytes,
      asOf: ev.createdAt,
      extract: deps.extract,
      cachedExtractor: (cand.extractorJson as ExtractorOutput | null) ?? null,
    });

    const parseLog = {
      wordCount: result.parsed.wordCount,
      hiddenText: result.parsed.hiddenText,
      injectionLines: result.parsed.injectionLines,
    };
    if (result.parsed.integrityCheck) flags.add("INTEGRITY_CHECK");

    if (result.kind === "unparseable") {
      await db.update(candidates).set({ parseLogJson: parseLog }).where(eq(candidates.id, cand.id));
      await needsReview(db, id, "unparseable", [...flags], { wordCount: result.parsed.wordCount });
      return "needs_review";
    }

    // Identity split (Step 5.2–5.3): everything identifying goes to `candidates` only.
    const ex = result.extractor;
    const key = recordKey(ex, bytes);
    const email = ex.identity.emails.find((e) => e.includes("@")) ?? null;
    if (!email) flags.add("NO_CONTACT");
    await db
      .update(candidates)
      .set({
        extractorJson: ex,
        parseLogJson: parseLog,
        recordKey: key,
        displayName: ex.identity.name,
        email,
        phone: ex.identity.phones[0] ?? null,
        urls: ex.identity.urls,
        noContact: !email,
        eligibilityRelocate: eligibility(ex),
      })
      .where(eq(candidates.id, cand.id));
    await linkDuplicates(db, cand.id, cand.poolId, key);

    const baseLog = {
      hiddenRuns: result.parsed.hiddenText.length,
      injectionLines: result.parsed.injectionLines.map((l) => l.pattern),
      fidelity: result.fidelity,
    };

    if (result.kind === "extraction_fidelity") {
      await needsReview(db, id, "extraction_fidelity", [...flags], baseLog);
      return "needs_review";
    }
    if (result.kind === "redaction_leak") {
      // The leaking profile is never stored; only the categories that leaked.
      await needsReview(db, id, "redaction_leak", [...flags], { ...baseLog, leaks: result.leaks });
      return "needs_review";
    }

    await db
      .update(evaluations)
      .set({
        status: "queued",
        claimedAt: null,
        flags: [...flags],
        visibleTextHash: result.visibleTextHash,
        redactedProfileText: result.profile.text,
        redactedProfileJson: result.profile.json,
        redactionLogJson: { ...baseLog, counts: result.profile.counts, leaks: [] },
      })
      .where(eq(evaluations.id, id));
    log("evaluation.prepared", { id });
    return "prepared";
  }
}

async function needsReview(db: Db, id: string, reason: string, flags: string[], redactionLog: object) {
  await db
    .update(evaluations)
    .set({
      status: "needs_review",
      tier: "R",
      tierReason: reason,
      flags,
      redactionLogJson: redactionLog,
      pipelineStatus: "scored",
      pipelineStatusAt: new Date(),
      claimedAt: null,
    })
    .where(eq(evaluations.id, id));
  log("evaluation.needs_review", { id, reason });
}

// Same pool + same record key = same person. Records are linked, never merged (rubric §4.5).
async function linkDuplicates(db: Db, candidateId: string, poolId: string, key: string) {
  const others = await db
    .select({ id: candidates.id })
    .from(candidates)
    .where(and(eq(candidates.poolId, poolId), eq(candidates.recordKey, key), ne(candidates.id, candidateId)));
  for (const o of others) {
    await db
      .update(candidates)
      .set({ linkedCandidateIds: sql`array(select distinct unnest(${candidates.linkedCandidateIds} || ARRAY[${o.id}]::uuid[]))` })
      .where(eq(candidates.id, candidateId));
    await db
      .update(candidates)
      .set({ linkedCandidateIds: sql`array(select distinct unnest(${candidates.linkedCandidateIds} || ARRAY[${candidateId}]::uuid[]))` })
      .where(eq(candidates.id, o.id));
  }
}

async function handleError(deps: Deps, ev: typeof evaluations.$inferSelect, err: unknown): Promise<Outcome> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  if (err instanceof InvalidOutputError) {
    await needsReview(db, ev.id, "invalid_output", ev.flags, { error: "invalid_output" });
    return "needs_review";
  }
  if (err instanceof TransientGeminiError) {
    const retries = ev.transientRetries + 1;
    if (retries > MAX_TRANSIENT_RETRIES) return fail(db, ev.id, err.message);
    // Exponential backoff, 30 s → 15 min. Rate limits don't use up the 3 real attempts.
    const delayMs = Math.min(30_000 * 2 ** (retries - 1), 15 * 60_000);
    await db
      .update(evaluations)
      .set({
        status: "queued",
        claimedAt: null,
        attempts: sql`${evaluations.attempts} - 1`,
        transientRetries: retries,
        nextAttemptAt: new Date(now.getTime() + delayMs),
        lastError: err.message,
      })
      .where(eq(evaluations.id, ev.id));
    log("evaluation.backoff", { id: ev.id, retries, delayMs });
    return "requeued";
  }
  const message = err instanceof Error ? err.name + ": " + err.message.slice(0, 200) : "unknown error";
  if (ev.attempts >= MAX_ATTEMPTS) return fail(db, ev.id, message);
  await db
    .update(evaluations)
    .set({ status: "queued", claimedAt: null, nextAttemptAt: new Date(now.getTime() + 60_000), lastError: message })
    .where(eq(evaluations.id, ev.id));
  log("evaluation.retry", { id: ev.id, attempts: ev.attempts });
  return "requeued";
}

async function fail(db: Db, id: string, message: string): Promise<Outcome> {
  await db.update(evaluations).set({ status: "failed", claimedAt: null, lastError: message }).where(eq(evaluations.id, id));
  log("evaluation.failed", { id });
  return "failed";
}
