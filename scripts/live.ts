// Shared by calibrate and regress: the real pipeline (Steps 2–8) on one file, with live
// Gemini, no database and retry-with-backoff on 429/5xx.
import { TransientGeminiError } from "../lib/gemini/client";
import { runExtractor } from "../lib/gemini/extractor";
import { runScorer, type ScorerRun } from "../lib/gemini/scorer";
import { runWriter } from "../lib/gemini/writer";
import type { PoolConfig } from "../lib/config/defaults";
import { prepareProfile, type PrepareResult } from "../lib/pipeline/prepare";
import { rankRuns, scoreRuns, writerEvidence } from "../lib/pipeline/score";
import type { RankResult, RoleApplied } from "../lib/score/rank";

export async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof TransientGeminiError) || attempt >= 6) throw err;
      const wait = Math.min(15_000 * 2 ** attempt, 240_000);
      console.log(`  ${label}: ${err.message}, retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

export type LiveResult =
  | { ok: false; prepared: PrepareResult }
  | { ok: true; prepared: Extract<PrepareResult, { kind: "ok" }>; runs: ScorerRun[]; rank: RankResult; briefOk: boolean };

export async function runLive(bytes: Uint8Array, asOf: Date, roleApplied: RoleApplied, config: PoolConfig, label: string): Promise<LiveResult> {
  const prepared = await withRetry(
    () => prepareProfile({ bytes, asOf, extract: async (t) => (await runExtractor(t)).data }),
    `${label} extractor`,
  );
  if (prepared.kind !== "ok") return { ok: false, prepared };
  const ctx = { profileText: prepared.profile.text, profileJson: prepared.profile.json, extractor: prepared.extractor, asOf, roleApplied, config };
  const runs = await withRetry(() => scoreRuns(ctx, async (p, i) => (await runScorer(p, i)).data), `${label} scorer`);
  const rank = rankRuns(ctx, runs);
  if (prepared.parsed.integrityCheck && !rank.flags.includes("INTEGRITY_CHECK")) rank.flags.push("INTEGRITY_CHECK");
  let briefOk = false;
  try {
    await withRetry(() => runWriter(writerEvidence(rank, config)), `${label} writer`);
    briefOk = true;
  } catch {
    briefOk = false;
  }
  return { ok: true, prepared, runs, rank, briefOk };
}
