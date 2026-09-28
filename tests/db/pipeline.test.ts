import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimNext } from "@/lib/db/claim";
import type { Db } from "@/lib/db/client";
import { candidates, evaluations, pools } from "@/lib/db/schema";
import { InvalidOutputError, TransientGeminiError } from "@/lib/gemini/client";
import { processEvaluation } from "@/lib/pipeline/process";
import { defaultConfig } from "@/lib/config/defaults";
import { makeDocx } from "../fixtures/build";
import { sampleExtractor } from "../fixtures/extractor";
import { testDb } from "./helpers";

beforeAll(() => {
  process.env.HMAC_SECRET = "test-hmac-secret";
});

let db: Db;
let poolId: string;

// A CV whose text is exactly what sampleExtractor() claims, so fidelity passes.
async function sampleCvBytes() {
  const ex = sampleExtractor();
  const lines = [
    ex.identity.name!,
    `${ex.identity.emails[0]} | ${ex.identity.phones[0]} | ${ex.identity.urls[0]} | ${ex.identity.locations[0]}`,
    ex.summary_raw!,
    ...ex.skills_raw,
    ...ex.roles.flatMap((r) => [`${r.title} | ${r.company_raw} | ${r.start_raw} – ${r.end_raw}`, ...r.bullets.map((b) => `– ${b}`)]),
    ...Array.from({ length: 8 }, (_, i) => `– Coordinated carrier follow-ups and delivery orders for importer account number ${i + 1} across the week.`),
  ];
  ex.roles[0].bullets.push(...lines.slice(-8).map((l) => l.slice(2)));
  return { bytes: await makeDocx(lines), ex };
}

async function addEvaluation(opts: { legacy?: boolean; createdAt?: Date } = {}) {
  const [cand] = await db.insert(candidates).values({ poolId, fileName: "cv.docx", legacy: opts.legacy ?? false }).returning();
  const [ev] = await db
    .insert(evaluations)
    .values({ poolId, candidateId: cand.id, roleApplied: "PM", filePath: `${poolId}/x.docx`, createdAt: opts.createdAt })
    .returning();
  return { ev, cand };
}

beforeEach(async () => {
  ({ db } = (await testDb()) as unknown as { db: Db });
  const [pool] = await db.insert(pools).values({ name: "p", configJson: defaultConfig, configHash: "c", rubricHash: "r" }).returning();
  poolId = pool.id;
});

describe("processEvaluation (Steps 2–5 persisted)", () => {
  it("stores the redacted profile, identity split and flags", async () => {
    const { bytes, ex } = await sampleCvBytes();
    const { ev, cand } = await addEvaluation({ legacy: true });
    const out = await processEvaluation(ev.id, { db, download: async () => bytes, extract: async () => ex });
    expect(out).toBe("prepared");

    const [e] = await db.select().from(evaluations).where(eq(evaluations.id, ev.id));
    expect(e.status).toBe("queued"); // waits for scoring (Phase 2)
    expect(e.redactedProfileText).toContain("[CANDIDATE]");
    expect(e.redactedProfileText).not.toMatch(/Priya|Raghavan|Pune|Zephyrline/);
    expect(JSON.stringify(e.redactedProfileJson)).not.toMatch(/Priya|Raghavan|@/);
    expect(JSON.stringify(e.redactionLogJson)).not.toMatch(/Priya|Raghavan|@/);
    expect(e.flags).toContain("LEGACY");

    const [c] = await db.select().from(candidates).where(eq(candidates.id, cand.id));
    expect(c.displayName).toBe("Priya Raghavan");
    expect(c.email).toBe("priya.raghavan@example.com");
    expect(c.recordKey).toMatch(/^e:[0-9a-f]{64}$/);
    expect(c.eligibilityRelocate).toBe("stated_yes");
    expect(c.extractorJson).toBeTruthy();
  });

  it("routes a thin CV to needs_review / tier R (unparseable) without calling Gemini", async () => {
    const bytes = await makeDocx(["Tiny CV", "Just a few words."]);
    const { ev } = await addEvaluation();
    let called = false;
    const out = await processEvaluation(ev.id, { db, download: async () => bytes, extract: async () => ((called = true), sampleExtractor()) });
    expect(out).toBe("needs_review");
    expect(called).toBe(false);
    const [e] = await db.select().from(evaluations).where(eq(evaluations.id, ev.id));
    expect(e).toMatchObject({ status: "needs_review", tier: "R", tierReason: "unparseable", pipelineStatus: "scored" });
  });

  it("never stores a profile that fails the leak check", async () => {
    const { bytes, ex } = await sampleCvBytes();
    ex.identity.name = null; // the Extractor missed the name
    const { ev } = await addEvaluation();
    const out = await processEvaluation(ev.id, { db, download: async () => bytes, extract: async () => ex });
    expect(out).toBe("needs_review");
    const [e] = await db.select().from(evaluations).where(eq(evaluations.id, ev.id));
    expect(e).toMatchObject({ tier: "R", tierReason: "redaction_leak", redactedProfileText: null });
    expect((e.redactionLogJson as { leaks: string[] }).leaks).toContain("name_not_found");
  });

  it("flags NO_CONTACT when there is no email", async () => {
    const { bytes, ex } = await sampleCvBytes();
    ex.identity.emails = [];
    const { ev, cand } = await addEvaluation();
    await processEvaluation(ev.id, { db, download: async () => bytes, extract: async () => ex });
    const [e] = await db.select().from(evaluations).where(eq(evaluations.id, ev.id));
    expect(e.flags).toContain("NO_CONTACT");
    const [c] = await db.select().from(candidates).where(eq(candidates.id, cand.id));
    expect(c.recordKey).toMatch(/^p:/);
  });

  it("links duplicates in the same pool, never merges them", async () => {
    const { bytes, ex } = await sampleCvBytes();
    const a = await addEvaluation();
    const b = await addEvaluation();
    await processEvaluation(a.ev.id, { db, download: async () => bytes, extract: async () => ex });
    await processEvaluation(b.ev.id, { db, download: async () => bytes, extract: async () => ex });
    const [ca] = await db.select().from(candidates).where(eq(candidates.id, a.cand.id));
    const [cb] = await db.select().from(candidates).where(eq(candidates.id, b.cand.id));
    expect(ca.linkedCandidateIds).toEqual([b.cand.id]);
    expect(cb.linkedCandidateIds).toEqual([a.cand.id]);
  });

  it("backs off on Gemini 429/5xx without using up an attempt", async () => {
    const { bytes } = await sampleCvBytes();
    const { ev } = await addEvaluation();
    await db.update(evaluations).set({ attempts: 1 }).where(eq(evaluations.id, ev.id));
    const now = new Date("2026-09-28T10:00:00Z");
    const out = await processEvaluation(ev.id, {
      db,
      download: async () => bytes,
      extract: async () => {
        throw new TransientGeminiError("Gemini HTTP 429");
      },
      now: () => now,
    });
    expect(out).toBe("requeued");
    const [e] = await db.select().from(evaluations).where(eq(evaluations.id, ev.id));
    expect(e).toMatchObject({ status: "queued", attempts: 0, transientRetries: 1, lastError: "Gemini HTTP 429" });
    expect(e.nextAttemptAt!.getTime()).toBe(now.getTime() + 30_000);
  });

  it("routes invalid model output to tier R (invalid_output)", async () => {
    const { bytes } = await sampleCvBytes();
    const { ev } = await addEvaluation();
    await processEvaluation(ev.id, {
      db,
      download: async () => bytes,
      extract: async () => {
        throw new InvalidOutputError("bad");
      },
    });
    const [e] = await db.select().from(evaluations).where(eq(evaluations.id, ev.id));
    expect(e).toMatchObject({ status: "needs_review", tier: "R", tierReason: "invalid_output" });
  });

  it("fails after 3 real attempts", async () => {
    const { ev } = await addEvaluation();
    await db.update(evaluations).set({ attempts: 3 }).where(eq(evaluations.id, ev.id));
    const out = await processEvaluation(ev.id, {
      db,
      download: async () => {
        throw new Error("storage down");
      },
      extract: async () => sampleExtractor(),
    });
    expect(out).toBe("failed");
  });
});

describe("claimNext (PRD §8.2)", () => {
  it("claims the oldest due row once, increments attempts, and skips it while leased", async () => {
    const first = await addEvaluation({ createdAt: new Date("2026-09-01") });
    await addEvaluation({ createdAt: new Date("2026-09-02") });
    const a = await claimNext(db, { preScoringOnly: false });
    expect(a?.id).toBe(first.ev.id);
    const [e] = await db.select().from(evaluations).where(eq(evaluations.id, first.ev.id));
    expect(e).toMatchObject({ status: "processing", attempts: 1 });
    const b = await claimNext(db, { preScoringOnly: false });
    expect(b?.id).not.toBe(first.ev.id);
    expect(await claimNext(db, { preScoringOnly: false })).toBeNull();
  });

  it("reclaims a row whose lease expired", async () => {
    const { ev } = await addEvaluation();
    await db.update(evaluations).set({ status: "processing", claimedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(evaluations.id, ev.id));
    expect((await claimNext(db, { preScoringOnly: false }))?.id).toBe(ev.id);
  });

  it("respects next_attempt_at", async () => {
    const { ev } = await addEvaluation();
    await db.update(evaluations).set({ nextAttemptAt: new Date(Date.now() + 60_000) }).where(eq(evaluations.id, ev.id));
    expect(await claimNext(db, { preScoringOnly: false })).toBeNull();
  });

  it("with the calibration gate closed, only claims CVs that still need redaction", async () => {
    const { ev } = await addEvaluation();
    await db.update(evaluations).set({ redactedProfileText: "[SUMMARY]\nx\n" }).where(eq(evaluations.id, ev.id));
    expect(await claimNext(db, { preScoringOnly: true })).toBeNull();
    expect((await claimNext(db, { preScoringOnly: false }))?.id).toBe(ev.id);
  });
});
