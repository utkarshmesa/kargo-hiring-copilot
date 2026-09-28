import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { candidates, evaluations, pools } from "@/lib/db/schema";
import { defaultConfig } from "@/lib/config/defaults";
import { InvalidOutputError } from "@/lib/gemini/client";
import { configHash } from "@/lib/hash";
import { processEvaluation } from "@/lib/pipeline/process";
import { rescorePool } from "@/lib/pipeline/rescore";
import { buildRedactedProfile } from "@/lib/redact/profile";
import { AS_OF, B_CASES, cvLines, mockRun } from "../fixtures/bcases";
import { makeDocx } from "../fixtures/build";
import { testDb } from "./helpers";

beforeAll(() => {
  process.env.HMAC_SECRET = "test-hmac-secret";
});

describe("re-scoring after a config change (rubric §3.1)", () => {
  it("recomputes totals and tiers from stored runs without calling Gemini, keeping non-ranking flags", async () => {
    const { db } = (await testDb()) as unknown as { db: Db };
    const [pool] = await db.insert(pools).values({ name: "p", configJson: defaultConfig, configHash: configHash(defaultConfig), rubricHash: "r" }).returning();
    const c = B_CASES.find((x) => x.id === "B1")!; // Tier A at exactly 70.0 with default weights
    const [cand] = await db.insert(candidates).values({ poolId: pool.id, legacy: true }).returning();
    const [ev] = await db.insert(evaluations).values({ poolId: pool.id, candidateId: cand.id, roleApplied: "PM", filePath: "x.docx", createdAt: AS_OF }).returning();
    const profile = buildRedactedProfile(c.extractor, AS_OF);
    const bytes = await makeDocx(cvLines(c.extractor));
    await processEvaluation(ev.id, {
      db,
      download: async () => bytes,
      extract: async () => c.extractor,
      score: async () => mockRun(c, profile.json),
      write: async () => {
        throw new InvalidOutputError("no writer");
      },
      modelId: "m",
      allowScoring: true,
    });
    let [e] = await db.select().from(evaluations).where(eq(evaluations.id, ev.id));
    expect(e.tier).toBe("A");
    expect(e.flags).toContain("LEGACY");

    // Raise the Tier A threshold: B1 (70.0) drops to B. No Gemini call is possible here.
    const stricter = { ...structuredClone(defaultConfig), tiers: { A: 75, B: 55, C: 40 } };
    const score = vi.fn();
    const n = await rescorePool(db, pool.id, stricter, configHash(stricter));
    expect(n).toBe(1);
    expect(score).not.toHaveBeenCalled();
    [e] = await db.select().from(evaluations).where(eq(evaluations.id, ev.id));
    expect(e.tier).toBe("B");
    expect(e.configHash).toBe(configHash(stricter));
    expect(e.flags).toEqual(expect.arrayContaining(["LEGACY", "WILDCARD"]));
  }, 30_000);
});
