import { NextResponse } from "next/server";
import { claimNext } from "@/lib/db/claim";
import { db } from "@/lib/db/client";
import { modelId } from "@/lib/gemini/client";
import { runExtractor } from "@/lib/gemini/extractor";
import { runScorer } from "@/lib/gemini/scorer";
import { runWriter } from "@/lib/gemini/writer";
import { processEvaluation } from "@/lib/pipeline/process";
import { calibrationPassed, currentPool } from "@/lib/pools";
import { downloadFile } from "@/lib/storage";

// PRD §8.2: one CV per invocation. The dashboard calls this in a loop while it is open;
// the daily cron drains what is left.
export const maxDuration = 300;

export async function POST() {
  const database = db();
  const pool = await currentPool(database);
  const gateOpen = await calibrationPassed(database, pool, modelId());

  // Gate closed: CVs are still parsed and redacted, but never scored.
  const claimed = await claimNext(database, { preScoringOnly: !gateOpen });
  if (!claimed) {
    return NextResponse.json(
      { processed: null, gateOpen, reason: gateOpen ? "queue empty" : "calibration has not passed for the current rubric, config and model" },
      { status: gateOpen ? 200 : 409 },
    );
  }
  const outcome = await processEvaluation(claimed.id, {
    db: database,
    download: downloadFile,
    extract: async (text) => (await runExtractor(text)).data,
    score: async (profile) => (await runScorer(profile)).data,
    write: runWriter,
    modelId: modelId(),
    allowScoring: gateOpen,
  });
  return NextResponse.json({ processed: claimed.id, outcome, gateOpen });
}
