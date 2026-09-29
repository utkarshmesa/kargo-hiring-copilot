import { beforeEach, describe, expect, it } from "vitest";
import { testDb } from "./helpers";
import { candidates, decisions, emails, evaluations, pools } from "@/lib/db/schema";
import { defaultConfig } from "@/lib/config/defaults";

let ctx: Awaited<ReturnType<typeof testDb>>;

async function seedEvaluation() {
  const { db } = ctx;
  const [pool] = await db.insert(pools).values({ name: "p", configJson: defaultConfig, configHash: "c", rubricHash: "r" }).returning();
  const [cand] = await db.insert(candidates).values({ poolId: pool.id }).returning();
  const [ev] = await db.insert(evaluations).values({ poolId: pool.id, candidateId: cand.id, roleApplied: "PM" }).returning();
  const [dec] = await db.insert(decisions).values({ evaluationId: ev.id, action: "advance", prevPipelineStatus: "scored" }).returning();
  return { ev, dec };
}

beforeEach(async () => {
  ctx = await testDb();
});

describe("database constraints", () => {
  it("allows only one email per (decision, kind)", async () => {
    const { dec } = await seedEvaluation();
    await ctx.db.insert(emails).values({ decisionId: dec.id, kind: "advance", idempotencyKey: `${dec.id}:advance` });
    await expect(
      ctx.db.insert(emails).values({ decisionId: dec.id, kind: "advance", idempotencyKey: `${dec.id}:advance-2` }),
    ).rejects.toThrow();
  });

  it("rejects a reused idempotency key (covers digests, which have no decision)", async () => {
    await ctx.db.insert(emails).values({ kind: "digest", idempotencyKey: "digest:2026-09-28" });
    await expect(ctx.db.insert(emails).values({ kind: "digest", idempotencyKey: "digest:2026-09-28" })).rejects.toThrow();
  });

  it("requires a decision for every candidate email and forbids one on the digest", async () => {
    const { dec } = await seedEvaluation();
    await expect(ctx.db.insert(emails).values({ kind: "decline", idempotencyKey: "x" })).rejects.toThrow();
    await expect(ctx.db.insert(emails).values({ decisionId: dec.id, kind: "digest", idempotencyKey: "y" })).rejects.toThrow();
  });

  it("forces needs_review to tier R", async () => {
    const { ev } = await seedEvaluation();
    const { eq } = await import("drizzle-orm");
    await expect(ctx.db.update(evaluations).set({ status: "needs_review", tier: "D" }).where(eq(evaluations.id, ev.id))).rejects.toThrow();
    await expect(ctx.db.update(evaluations).set({ status: "needs_review" }).where(eq(evaluations.id, ev.id))).rejects.toThrow();
    await ctx.db.update(evaluations).set({ status: "needs_review", tier: "R", tierReason: "unparseable" }).where(eq(evaluations.id, ev.id));
  });

  it("rejects values outside the enums", async () => {
    const { ev } = await seedEvaluation();
    await expect(
      ctx.client.query(`UPDATE evaluations SET pipeline_status = 'hired' WHERE id = $1`, [ev.id]),
    ).rejects.toThrow();
  });
});

describe("first pool", () => {
  it("concurrent first requests create exactly one pool", async () => {
    const { currentPool } = await import("@/lib/pools");
    const fresh = await testDb();
    const got = await Promise.all(Array.from({ length: 5 }, () => currentPool(fresh.db as never)));
    expect(new Set(got.map((p) => p.id)).size).toBe(1);
    expect((await fresh.db.select().from(pools)).length).toBe(1);
  });
});
