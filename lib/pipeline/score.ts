import type { PoolConfig } from "@/lib/config/defaults";
import type { ExtractorOutput } from "@/lib/gemini/extractor";
import type { ScorerRun } from "@/lib/gemini/scorer";
import type { Brief } from "@/lib/gemini/writer";
import type { RedactedProfileJson } from "@/lib/redact/profile";
import { DIM_NAMES, FLAG_TEXT } from "@/lib/score/labels";
import { countedDims, rank, type RankResult, type RoleApplied } from "@/lib/score/rank";

// Steps 6–8 for one prepared CV, without the database.

export type Score = (profileText: string, runIndex: number) => Promise<ScorerRun>;
export type Write = (evidence: unknown) => Promise<Brief & { removed: string[] }>;

export type ScoreContext = {
  profileText: string;
  profileJson: RedactedProfileJson;
  extractor: ExtractorOutput;
  asOf: Date;
  roleApplied: RoleApplied;
  config: PoolConfig;
};

/** Step 6: runsPerCv independent Scorer calls, each a fresh request. */
export async function scoreRuns(ctx: ScoreContext, score: Score): Promise<ScorerRun[]> {
  return Promise.all(Array.from({ length: ctx.config.runsPerCv }, (_, i) => score(ctx.profileText, i)));
}

export function rankRuns(ctx: ScoreContext, runs: ScorerRun[]): RankResult {
  return rank({ ...ctx, runs });
}

/** Step 8 input: verified evidence only. Quotes that failed the check are never passed on. */
export function writerEvidence(r: RankResult, config: PoolConfig) {
  const weights = config.weights[r.roleUsed];
  return {
    role: r.roleUsed === "PM" ? "Product Manager" : "Senior Product Manager",
    tier: r.tier,
    total: Math.round((r.roleUsed === "PM" ? r.pmTotal : r.spmTotal) * 10) / 10,
    core_score: Math.round(r.coreScore * 10) / 10,
    flags: r.flags.filter((f) => f !== "LEGACY" && f !== "NO_CONTACT").map((f) => ({ flag: f, meaning: FLAG_TEXT[f] ?? f })),
    experience_fit: { dimension: "D7", name: DIM_NAMES.D7, score: r.d7[r.roleUsed], weight: weights.D7 },
    dimensions: countedDims(r.roleUsed).map((id) => {
      const d = r.dims[id];
      return {
        dimension: id,
        name: DIM_NAMES[id],
        weight: weights[id],
        score: d.score,
        evidence_status: d.evidence_status,
        confidence: d.confidence,
        verified_quotes: d.quoteMismatch ? [] : d.evidence.map((e) => e.quote),
        rationale: d.quoteMismatch ? "Quote not found in the CV; scored 0." : d.rationale,
      };
    }),
  };
}
