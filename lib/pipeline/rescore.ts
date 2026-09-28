import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { PoolConfig } from "@/lib/config/defaults";
import type { Db } from "@/lib/db/client";
import { candidates, evaluations } from "@/lib/db/schema";
import type { ExtractorOutput } from "@/lib/gemini/extractor";
import type { ScorerRun } from "@/lib/gemini/scorer";
import type { RedactedProfileJson } from "@/lib/redact/profile";
import { rankRuns } from "./score";

// Rubric §3.1: changing a weight or threshold re-scores the whole pool. Totals, tiers and
// flags are recomputed from the stored raw runs; Gemini is never called again.

// Flags that come from ranking and depend on config. Everything else (LEGACY, NO_CONTACT,
// BOUNCED, INTEGRITY_CHECK from parsing) is kept as it is.
const RANK_FLAGS = new Set([
  "WILDCARD",
  "VERIFY_CLAIM",
  "QUOTE_MISMATCH",
  "UNSTABLE_SCORE",
  "BELOW_EXPERIENCE_BAND",
  "CONSIDER_SPM",
  "CONSIDER_PM",
  "LEVEL_CHECK",
]);

export async function rescorePool(db: Db, poolId: string, config: PoolConfig, configHash: string): Promise<number> {
  const rows = await db
    .select({ ev: evaluations, cand: candidates })
    .from(evaluations)
    .innerJoin(candidates, eq(candidates.id, evaluations.candidateId))
    .where(and(eq(evaluations.poolId, poolId), isNotNull(evaluations.runScoresJson), inArray(evaluations.status, ["scored", "needs_review"])));
  for (const { ev, cand } of rows) {
    const runs = (ev.runScoresJson as { runs: ScorerRun[] }).runs;
    const r = rankRuns(
      {
        profileText: ev.redactedProfileText!,
        profileJson: ev.redactedProfileJson as RedactedProfileJson,
        extractor: cand.extractorJson as ExtractorOutput,
        asOf: ev.createdAt,
        roleApplied: ev.roleApplied,
        config,
      },
      runs,
    );
    const flags = [...new Set([...ev.flags.filter((f) => !RANK_FLAGS.has(f)), ...r.flags])];
    await db
      .update(evaluations)
      .set({
        status: r.tier === "R" ? "needs_review" : "scored",
        dimsFinalJson: { dims: r.dims, d7: r.d7, qualifiers: r.qualifiers, roleUsed: r.roleUsed },
        experienceJson: r.experience,
        pmTotal: r.pmTotal,
        spmTotal: r.spmTotal,
        coreScore: r.coreScore,
        bestFitRole: r.bestFitRole,
        tier: r.tier,
        tierReason: r.tierReason,
        flags,
        configHash,
      })
      .where(eq(evaluations.id, ev.id));
  }
  return rows.length;
}
