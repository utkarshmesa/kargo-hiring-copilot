import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { candidates, decisions, emails, evaluations, pools } from "@/lib/db/schema";
import { defaultConfig } from "@/lib/config/defaults";
import { applyRetention, istDate, reconcileEmails, sendDailyDigest, sendNudges } from "@/lib/cron";
import { decide } from "@/lib/decisions";
import type { ResendLike } from "@/lib/email/send";
import { testDb } from "./helpers";

function fakeResend(lastEvent = "delivered") {
  const sent: Record<string, unknown>[] = [];
  let n = 0;
  const resend = {
    emails: {
      send: async (payload: Record<string, unknown>) => {
        sent.push(payload);
        return { data: { id: `re_${++n}` }, error: null };
      },
      cancel: async (id: string) => ({ data: { id }, error: null }),
      get: async () => ({ data: { last_event: lastEvent }, error: null }),
    },
    webhooks: { verify: () => ({}) },
  } as unknown as ResendLike;
  return { resend, sent };
}

let db: Db;
let poolId: string;
const T0 = new Date("2026-10-01T04:00:00Z");
const days = (n: number) => new Date(T0.getTime() + n * 86_400_000);

async function candidate(name: string, pipelineStatus = "scored") {
  const [c] = await db.insert(candidates).values({ poolId, displayName: name, email: `${name.split(" ")[0].toLowerCase()}@example.com` }).returning();
  const [e] = await db
    .insert(evaluations)
    .values({ poolId, candidateId: c.id, roleApplied: "PM", status: "scored", tier: "B", pipelineStatus: pipelineStatus as "scored", pipelineStatusAt: T0, createdAt: T0, filePath: `${poolId}/${c.id}.docx`, redactedProfileText: "[SUMMARY]\nx\n", briefJson: { invite_line: "Loved your work." } })
    .returning();
  return { c, e };
}

beforeEach(async () => {
  ({ db } = (await testDb()) as unknown as { db: Db });
  const [pool] = await db.insert(pools).values({ name: "p", configJson: defaultConfig, configHash: "c", rubricHash: "r" }).returning();
  poolId = pool.id;
  process.env.EMAIL_FROM = "Arjun <onboarding@resend.dev>";
  process.env.ARJUN_EMAIL = "arjun@example.com";
  process.env.BOOKING_URL = "https://cal.example.com/arjun";
  process.env.APP_URL = "https://kargo.example.com";
  delete process.env.EMAIL_REDIRECT_TO;
});

describe("nudge (US8)", () => {
  it("sends one nudge 3 days after the invite went out, and never a second", async () => {
    const { e } = await candidate("Asha Rao");
    const { resend, sent } = fakeResend();
    const d = { db, resend, now: () => T0 };
    await decide({ evaluationId: e.id, action: "advance" }, d);
    await reconcileEmails({ db, resend, now: () => days(1) }); // invite delivered
    expect(await sendNudges({ db, resend, now: () => days(2) })).toBe(0); // too early
    expect(await sendNudges({ db, resend, now: () => days(4) })).toBe(1);
    expect(await sendNudges({ db, resend, now: () => days(5) })).toBe(0); // one only
    expect(sent.map((s) => s.subject)).toEqual(["Next step: Product Manager at Kargo", "Re: Next step: Product Manager at Kargo"]);
  });

  it("does not nudge someone who booked", async () => {
    const { e } = await candidate("Asha Rao");
    const { resend } = fakeResend();
    await decide({ evaluationId: e.id, action: "advance" }, { db, resend, now: () => T0 });
    await reconcileEmails({ db, resend, now: () => days(1) });
    await db.update(evaluations).set({ pipelineStatus: "booked" }).where(eq(evaluations.id, e.id));
    expect(await sendNudges({ db, resend, now: () => days(4) })).toBe(0);
  });
});

describe("digest (B.6)", () => {
  it("goes to Arjun once a day, with holds due at the top and the pipeline counts", async () => {
    await candidate("Waiting One");
    const { e: held } = await candidate("Held Person");
    const { resend, sent } = fakeResend();
    await decide({ evaluationId: held.id, action: "hold", holdUntil: "2026-10-05" }, { db, resend, now: () => T0 });
    const r = await sendDailyDigest({ db, resend, now: () => days(4) }); // 5 Oct IST
    expect(r.ok).toBe(true);
    const digest = sent.at(-1)!;
    expect(digest.to).toBe("arjun@example.com");
    expect(digest.subject).toMatch(/^Hiring: 1 waiting · \d+ weeks to target$/);
    expect(String(digest.text).startsWith("Holds due today: decide again on Held Person.")).toBe(true);
    expect(digest.text).toContain("https://kargo.example.com/shortlist");
    expect((await sendDailyDigest({ db, resend, now: () => days(4) })).ok).toBe(false); // repeat run
  });

  it("uses the India calendar day", () => {
    expect(istDate(new Date("2026-10-01T19:00:00Z"))).toBe("2026-10-02");
    expect(istDate(new Date("2026-10-01T18:00:00Z"))).toBe("2026-10-01");
  });
});

describe("email reconciliation", () => {
  it("sends what is due, then learns from Resend what happened and flags bounces", async () => {
    const { e } = await candidate("Asha Rao");
    const { resend } = fakeResend("bounced");
    await decide({ evaluationId: e.id, action: "advance" }, { db, resend, now: () => T0 });
    expect(await reconcileEmails({ db, resend, now: () => T0 })).toEqual({ sent: 0, synced: 0 }); // not due yet
    expect(await reconcileEmails({ db, resend, now: () => days(1) })).toEqual({ sent: 1, synced: 0 }); // just sent: give the webhook time
    expect(await reconcileEmails({ db, resend, now: () => days(2) })).toEqual({ sent: 0, synced: 1 });
    const [m] = await db.select().from(emails).where(eq(emails.evaluationId, e.id));
    expect(m.status).toBe("bounced");
    const [ev] = await db.select().from(evaluations).where(eq(evaluations.id, e.id));
    expect(ev.flags).toContain("BOUNCED");
  });
});

describe("retention (180 days after close)", () => {
  it("deletes files and identity, strips CV text, keeps numeric scores and decisions", async () => {
    const { c, e } = await candidate("Asha Rao");
    await db
      .update(evaluations)
      .set({ pmTotal: 71, tier: "A", dimsFinalJson: { dims: { D1: { id: "D1", score: 4, runScores: [4, 4, 4], evidence_status: "present", confidence: "high", evidence: [{ quote: "ran the import desk" }], rationale: "x" } }, roleUsed: "PM" } })
      .where(eq(evaluations.id, e.id));
    await db.insert(decisions).values({ evaluationId: e.id, action: "decline", reason: "not now", prevPipelineStatus: "scored" });
    await db.update(pools).set({ closedAt: T0 }).where(eq(pools.id, poolId));
    const removed: string[] = [];
    const remove = async (p: string[]) => void removed.push(...p);

    expect(await applyRetention({ db, now: () => days(179), remove })).toBe(0);
    expect(await applyRetention({ db, now: () => days(181), remove })).toBe(1);
    expect(await applyRetention({ db, now: () => days(182), remove })).toBe(0); // idempotent

    expect(removed).toEqual([e.filePath]);
    const [cand] = await db.select().from(candidates).where(eq(candidates.id, c.id));
    expect(cand).toMatchObject({ displayName: null, email: null, extractorJson: null, fileName: null });
    expect(cand.deletedAt).not.toBeNull();
    const [ev] = await db.select().from(evaluations).where(eq(evaluations.id, e.id));
    expect(ev).toMatchObject({ pmTotal: 71, tier: "A", redactedProfileText: null, briefJson: null, filePath: null });
    expect(JSON.stringify(ev.dimsFinalJson)).not.toContain("import desk");
    expect(JSON.stringify(ev.dimsFinalJson)).toContain('"score":4');
    const [d] = await db.select().from(decisions).where(eq(decisions.evaluationId, e.id));
    expect(d).toMatchObject({ action: "decline", reason: null });
  });
});
