import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { candidates, evaluations, pools } from "@/lib/db/schema";
import { defaultConfig } from "@/lib/config/defaults";
import { InvalidOutputError, TransientGeminiError } from "@/lib/gemini/client";
import type { Brief } from "@/lib/gemini/writer";
import { processEvaluation } from "@/lib/pipeline/process";
import { buildRedactedProfile } from "@/lib/redact/profile";
import { configHash } from "@/lib/hash";
import { AS_OF, B_CASES, cvLines, mockRun } from "../fixtures/bcases";
import { makeDocx } from "../fixtures/build";
import { testDb } from "./helpers";

beforeAll(() => {
  process.env.HMAC_SECRET = "test-hmac-secret";
});

const c = B_CASES.find((x) => x.id === "B6")!;
const brief: Brief & { removed: string[] } = {
  why_ranked_here: "Hands-on warehouse operations plus a product role owning a yard product.",
  top_strengths: ["Ops floor experience", "Reversed a rule on evidence", "Field discovery"],
  top_gaps: ["Limited platform work"],
  interview_probes: ["Walk me through a normal shift.", "What did you reverse, and why?", "What changed for gate staff?"],
  invite_line: "Your gate check-in redesign that cut truck waits stood out.",
  what_would_change_this_score: "Evidence of integration ownership.",
  removed: [],
};

let db: Db;
let evId: string;

beforeEach(async () => {
  ({ db } = (await testDb()) as unknown as { db: Db });
  const [pool] = await db.insert(pools).values({ name: "p", configJson: defaultConfig, configHash: configHash(defaultConfig), rubricHash: "r" }).returning();
  const [cand] = await db.insert(candidates).values({ poolId: pool.id, fileName: "b6.docx" }).returning();
  const [ev] = await db
    .insert(evaluations)
    .values({ poolId: pool.id, candidateId: cand.id, roleApplied: "PM", filePath: `${pool.id}/b6.docx`, createdAt: AS_OF })
    .returning();
  evId = ev.id;
});

async function deps(overrides: Partial<Parameters<typeof processEvaluation>[1]> = {}) {
  const bytes = await makeDocx(cvLines(c.extractor));
  const profile = buildRedactedProfile(c.extractor, AS_OF);
  return {
    db,
    download: async () => bytes,
    extract: async () => c.extractor,
    score: vi.fn(async () => mockRun(c, profile.json)),
    write: vi.fn(async () => brief),
    modelId: "gemini-test-1",
    allowScoring: true,
    ...overrides,
  };
}

describe("scoring stage (Steps 6–8 persisted)", () => {
  it("scores a CV end to end and stores raw runs, totals, tier, flags, brief and hashes", async () => {
    const d = await deps();
    expect(await processEvaluation(evId, d)).toBe("scored");
    expect(d.score).toHaveBeenCalledTimes(3);
    const [e] = await db.select().from(evaluations).where(eq(evaluations.id, evId));
    expect(e).toMatchObject({ status: "scored", tier: "A", pipelineStatus: "scored", modelId: "gemini-test-1", configHash: configHash(defaultConfig) });
    expect(e.pmTotal).toBeCloseTo(80);
    expect((e.runScoresJson as { runs: unknown[] }).runs).toHaveLength(3);
    expect(e.briefJson).toMatchObject({ invite_line: brief.invite_line });
    expect(e.rubricHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(e.dimsFinalJson)).not.toMatch(/Neha|Kulkarni|Dockyard/);
  });

  it("does not score while the calibration gate is closed", async () => {
    const d = await deps({ allowScoring: false });
    expect(await processEvaluation(evId, d)).toBe("prepared");
    expect(d.score).not.toHaveBeenCalled();
    const [e] = await db.select().from(evaluations).where(eq(evaluations.id, evId));
    expect(e).toMatchObject({ status: "queued", tier: null });
  });

  it("keeps the raw runs when the Writer is rate-limited, and does not re-score on retry", async () => {
    const d = await deps({
      write: vi.fn(async () => {
        throw new TransientGeminiError("Gemini HTTP 429");
      }),
    });
    expect(await processEvaluation(evId, d)).toBe("requeued");
    const [mid] = await db.select().from(evaluations).where(eq(evaluations.id, evId));
    expect(mid.runScoresJson).toBeTruthy();
    const again = await deps();
    expect(await processEvaluation(evId, again)).toBe("scored");
    expect(again.score).not.toHaveBeenCalled();
  });

  it("an invalid Writer output leaves the scores and marks the brief unavailable", async () => {
    const d = await deps({
      write: vi.fn(async () => {
        throw new InvalidOutputError("bad");
      }),
    });
    expect(await processEvaluation(evId, d)).toBe("scored");
    const [e] = await db.select().from(evaluations).where(eq(evaluations.id, evId));
    expect(e.briefJson).toBeNull();
    expect(e.tier).toBe("A");
  });

  it("invalid Scorer output after retries → tier R (invalid_output)", async () => {
    const d = await deps({
      score: vi.fn(async () => {
        throw new InvalidOutputError("bad");
      }),
    });
    expect(await processEvaluation(evId, d)).toBe("needs_review");
    const [e] = await db.select().from(evaluations).where(eq(evaluations.id, evId));
    expect(e).toMatchObject({ status: "needs_review", tier: "R", tierReason: "invalid_output" });
  });

  it("a tier R result is stored as needs_review", async () => {
    const profile = buildRedactedProfile(c.extractor, AS_OF);
    const unstable = [mockRun(c, profile.json, { D4: 1 }), mockRun(c, profile.json), mockRun(c, profile.json)];
    let i = 0;
    const d = await deps({ score: vi.fn(async () => unstable[i++]) });
    expect(await processEvaluation(evId, d)).toBe("needs_review");
    const [e] = await db.select().from(evaluations).where(eq(evaluations.id, evId));
    expect(e).toMatchObject({ status: "needs_review", tier: "R" });
    expect(e.flags).toContain("UNSTABLE_SCORE");
  });
});
