import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { candidates, decisions, emails, evaluations, pools } from "@/lib/db/schema";
import { defaultConfig } from "@/lib/config/defaults";
import { decide, DecisionError, setStatus, undo } from "@/lib/decisions";
import { cancelDecisionEmails, sendDigest, sendForDecision, type ResendLike } from "@/lib/email/send";
import { applyEmailEvent } from "@/lib/email/events";
import { PRIVACY_FOOTER } from "@/lib/email/templates";
import { testDb } from "./helpers";

// The Cut (PRD Step 11): proven here, not just asserted in comments.

type Sent = { payload: Record<string, unknown>; key?: string };
function fakeResend(opts: { cancelFails?: boolean; lastEvent?: string; sendError?: boolean; delayMs?: number } = {}) {
  const sent: Sent[] = [];
  const cancelled: string[] = [];
  const byKey = new Map<string, string>();
  let n = 0;
  const resend = {
    emails: {
      send: async (payload: Record<string, unknown>, options?: { idempotencyKey?: string }) => {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        if (opts.sendError) return { data: null, error: { name: "validation_error", message: "bad", statusCode: 422 } };
        const key = options?.idempotencyKey;
        if (key && byKey.has(key)) return { data: { id: byKey.get(key)! }, error: null }; // Resend dedupes
        const id = `re_${++n}`;
        if (key) byKey.set(key, id);
        sent.push({ payload, key });
        return { data: { id }, error: null };
      },
      cancel: async (id: string) => {
        if (opts.cancelFails) return { data: null, error: { name: "invalid_parameter", message: "cannot cancel", statusCode: 422 } };
        cancelled.push(id);
        return { data: { object: "email", id }, error: null };
      },
      get: async () => ({ data: { last_event: opts.lastEvent ?? "scheduled" }, error: null }),
    },
    webhooks: { verify: () => ({}) },
  } as unknown as ResendLike;
  return { resend, sent, cancelled };
}

let db: Db;
let evId: string;
let poolId: string;
const NOW = new Date("2026-10-01T09:00:00Z");

async function seed(opts: { email?: string | null; brief?: object | null; legacy?: boolean; relocate?: "unstated" | "stated_yes" } = {}) {
  const [cand] = await db
    .insert(candidates)
    .values({
      poolId,
      displayName: "PRIYA RAGHAVAN",
      email: opts.email === undefined ? "priya@example.com" : opts.email,
      noContact: opts.email === null,
      legacy: opts.legacy ?? false,
      eligibilityRelocate: opts.relocate ?? "unstated",
    })
    .returning();
  const [ev] = await db
    .insert(evaluations)
    .values({
      poolId,
      candidateId: cand.id,
      roleApplied: "PM",
      status: "scored",
      tier: "A",
      pipelineStatus: "scored",
      briefJson: opts.brief === undefined ? { invite_line: "Your gate check-in redesign stood out.", why_ranked_here: "AI SUMMARY TEXT" } : opts.brief,
    })
    .returning();
  return ev.id;
}

beforeEach(async () => {
  ({ db } = (await testDb()) as unknown as { db: Db });
  const [pool] = await db.insert(pools).values({ name: "p", configJson: defaultConfig, configHash: "c", rubricHash: "r" }).returning();
  poolId = pool.id;
  evId = await seed();
  process.env.EMAIL_FROM = "Arjun at Kargo <onboarding@resend.dev>";
  process.env.ARJUN_EMAIL = "arjun@example.com";
  process.env.BOOKING_URL = "https://cal.example.com/arjun";
  delete process.env.EMAIL_REDIRECT_TO;
});

const deps = (resend: ResendLike) => ({ db, resend, now: () => NOW });

describe("sendForDecision: refuses without a valid decision", () => {
  it("refuses when the decision does not exist", async () => {
    const { resend, sent } = fakeResend();
    const r = await sendForDecision("00000000-0000-0000-0000-000000000000", "decline", deps(resend));
    expect(r).toMatchObject({ ok: false, reason: "no_decision" });
    expect(sent).toHaveLength(0);
  });

  it("refuses a kind that doesn't match the decision (an Advance can't send a Decline)", async () => {
    const { resend, sent } = fakeResend();
    const [d] = await db.insert(decisions).values({ evaluationId: evId, action: "advance", prevPipelineStatus: "scored" }).returning();
    expect(await sendForDecision(d.id, "decline", deps(resend))).toMatchObject({ ok: false, reason: "wrong_kind" });
    expect(await sendForDecision(d.id, "hold", deps(resend))).toMatchObject({ ok: false, reason: "wrong_kind" });
    expect(sent).toHaveLength(0);
  });

  it("refuses an undone decision", async () => {
    const { resend, sent } = fakeResend();
    const [d] = await db.insert(decisions).values({ evaluationId: evId, action: "decline", prevPipelineStatus: "scored", undoneAt: NOW }).returning();
    expect(await sendForDecision(d.id, "decline", deps(resend))).toMatchObject({ ok: false, reason: "decision_undone" });
    expect(sent).toHaveLength(0);
  });

  it("the database refuses a candidate email row without a decision", async () => {
    await expect(db.insert(emails).values({ evaluationId: evId, kind: "decline", idempotencyKey: "x" })).rejects.toThrow();
  });
});

describe("sendForDecision: sends exactly once", () => {
  it("a second send for the same decision and kind is refused", async () => {
    const { resend, sent } = fakeResend();
    const [d] = await db.insert(decisions).values({ evaluationId: evId, action: "decline", prevPipelineStatus: "scored" }).returning();
    expect((await sendForDecision(d.id, "decline", deps(resend))).ok).toBe(true);
    expect(await sendForDecision(d.id, "decline", deps(resend))).toMatchObject({ ok: false, reason: "already_sent" });
    expect(sent).toHaveLength(1);
    expect(sent[0].key).toBe(`${d.id}:decline`);
  });

  it("concurrent sends for the same decision produce one email", async () => {
    const { resend, sent } = fakeResend({ delayMs: 20 });
    const [d] = await db.insert(decisions).values({ evaluationId: evId, action: "decline", prevPipelineStatus: "scored" }).returning();
    const results = await Promise.all(Array.from({ length: 5 }, () => sendForDecision(d.id, "decline", deps(resend))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(sent).toHaveLength(1);
    const rows = await db.select().from(emails).where(eq(emails.decisionId, d.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("scheduled");
  });

  it("a failed Resend call can be retried with the same key, and only then", async () => {
    const [d] = await db.insert(decisions).values({ evaluationId: evId, action: "decline", prevPipelineStatus: "scored" }).returning();
    const bad = fakeResend({ sendError: true });
    expect(await sendForDecision(d.id, "decline", deps(bad.resend))).toMatchObject({ ok: false, reason: "resend_error" });
    const good = fakeResend();
    expect((await sendForDecision(d.id, "decline", deps(good.resend))).ok).toBe(true);
    expect(good.sent[0].key).toBe(`${d.id}:decline`);
    expect(await sendForDecision(d.id, "decline", deps(good.resend))).toMatchObject({ ok: false, reason: "already_sent" });
  });

  it("no email address → nothing is sent (NO_CONTACT)", async () => {
    const id = await seed({ email: null });
    const { resend, sent } = fakeResend();
    const [d] = await db.insert(decisions).values({ evaluationId: id, action: "decline", prevPipelineStatus: "scored" }).returning();
    expect(await sendForDecision(d.id, "decline", deps(resend))).toMatchObject({ ok: false, reason: "no_contact" });
    expect(sent).toHaveLength(0);
  });
});

describe("what gets sent", () => {
  it("schedules Advance +10 min, Hold +10 min, Decline +24 h, replies to Arjun", async () => {
    const { resend, sent } = fakeResend();
    await decide({ evaluationId: evId, action: "advance" }, deps(resend));
    const e2 = await seed();
    await decide({ evaluationId: e2, action: "decline" }, deps(resend));
    const e3 = await seed();
    await decide({ evaluationId: e3, action: "hold", holdUntil: "2026-10-22" }, deps(resend));
    expect(sent.map((s) => s.payload.scheduledAt)).toEqual([
      "2026-10-01T09:10:00.000Z",
      "2026-10-02T09:00:00.000Z",
      "2026-10-01T09:10:00.000Z",
    ]);
    for (const s of sent) expect(s.payload).toMatchObject({ replyTo: "arjun@example.com", from: "Arjun at Kargo <onboarding@resend.dev>" });
  });

  it("the Decline contains zero AI text: exactly the fixed template", async () => {
    const { resend, sent } = fakeResend();
    await decide({ evaluationId: evId, action: "decline" }, deps(resend));
    const text = sent[0].payload.text as string;
    expect(text).not.toContain("gate check-in"); // the AI invite line
    expect(text).not.toContain("AI SUMMARY TEXT");
    expect(text).toBe(
      [
        "Hi Priya,",
        "Thank you for taking the time to apply for the Product Manager role at Kargo. We've reviewed your application carefully and have decided not to move forward with it for this role.",
        "We appreciate your interest in Kargo and wish you the very best in your search.",
        "Arjun Mehta, Founder, Kargo",
        PRIVACY_FOOTER,
      ].join("\n\n"),
    );
  });

  it("the Advance carries only Arjun's approved invite line, the booking link and the relocation question", async () => {
    const { resend, sent } = fakeResend();
    await decide({ evaluationId: evId, action: "advance", inviteLineOverride: "Loved your yard-management work." }, deps(resend));
    const text = sent[0].payload.text as string;
    expect(text).toContain("Loved your yard-management work.");
    expect(text).not.toContain("gate check-in");
    expect(text).toContain("https://cal.example.com/arjun");
    expect(text).toContain("relocation is something you'd consider");
    expect(sent[0].payload.subject).toBe("Next step: Product Manager at Kargo");
  });

  it("legacy candidates get the apology opening", async () => {
    const id = await seed({ legacy: true });
    const { resend, sent } = fakeResend();
    await decide({ evaluationId: id, action: "hold", holdUntil: "2026-10-22" }, deps(resend));
    expect(sent[0].payload.text).toContain("Apologies for how long it has taken us to get back to you. Thank you for applying");
    expect(sent[0].payload.text).toContain("by 22 October 2026");
  });

  it("EMAIL_REDIRECT_TO sends every candidate email to the test inbox instead", async () => {
    process.env.EMAIL_REDIRECT_TO = "tester@example.com";
    const { resend, sent } = fakeResend();
    await decide({ evaluationId: evId, action: "decline" }, deps(resend));
    expect(sent[0].payload.to).toBe("tester@example.com");
  });

  it("the digest goes only to ARJUN_EMAIL, once per day", async () => {
    const { resend, sent } = fakeResend();
    const data = { nWaiting: 3, oldestDays: 4, dashboardUrl: "https://app", weeksLeft: 13, holdsDue: [], interviewedStale: [], notBooked: [], bounced: [], counts: { advanced: 1, booked: 0, interviewed: 0, offer: 0 } };
    expect((await sendDigest("2026-10-01", data, deps(resend))).ok).toBe(true);
    expect(await sendDigest("2026-10-01", data, deps(resend))).toMatchObject({ ok: false, reason: "already_sent" });
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.to).toBe("arjun@example.com");
    expect(sent[0].key).toBe("digest:2026-10-01");
  });
});

describe("nudge", () => {
  it("only for a non-undone Advance whose invite went out and who has not booked", async () => {
    const { resend, sent } = fakeResend();
    const { decision } = await decide({ evaluationId: evId, action: "advance" }, deps(resend));
    // Invite not delivered yet → no nudge.
    expect(await sendForDecision(decision.id, "nudge", deps(resend))).toMatchObject({ ok: false, reason: "not_eligible" });
    await db.update(emails).set({ status: "delivered" }).where(eq(emails.decisionId, decision.id));
    expect((await sendForDecision(decision.id, "nudge", deps(resend))).ok).toBe(true);
    expect(await sendForDecision(decision.id, "nudge", deps(resend))).toMatchObject({ ok: false, reason: "already_sent" });
    expect(sent.map((s) => s.key)).toEqual([`${decision.id}:advance`, `${decision.id}:nudge`]);
  });

  it("never after the candidate booked", async () => {
    const { resend } = fakeResend();
    const { decision } = await decide({ evaluationId: evId, action: "advance" }, deps(resend));
    await db.update(emails).set({ status: "delivered" }).where(eq(emails.decisionId, decision.id));
    await setStatus(evId, "booked", deps(resend));
    expect(await sendForDecision(decision.id, "nudge", deps(resend))).toMatchObject({ ok: false, reason: "not_eligible" });
  });
});

describe("decide", () => {
  it("records the recommended tier, moves the status and locks the pool", async () => {
    const { resend } = fakeResend();
    const { decision } = await decide({ evaluationId: evId, action: "decline", reason: "not now" }, deps(resend));
    expect(decision).toMatchObject({ recommendedTier: "A", prevPipelineStatus: "scored", reason: "not now" });
    const [ev] = await db.select().from(evaluations).where(eq(evaluations.id, evId));
    expect(ev.pipelineStatus).toBe("declined");
    const [pool] = await db.select().from(pools).where(eq(pools.id, poolId));
    expect(pool.lockedAt).not.toBeNull();
  });

  it("a double click creates one decision and one email", async () => {
    const { resend, sent } = fakeResend({ delayMs: 10 });
    const results = await Promise.allSettled([decide({ evaluationId: evId, action: "advance" }, deps(resend)), decide({ evaluationId: evId, action: "advance" }, deps(resend))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(decisions).where(eq(decisions.evaluationId, evId))).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("refuses a new decision while an email is still scheduled", async () => {
    const { resend } = fakeResend();
    await decide({ evaluationId: evId, action: "advance" }, deps(resend));
    await expect(decide({ evaluationId: evId, action: "decline" }, deps(resend))).rejects.toThrow(/Undo it first/);
  });

  it("rolls the decision back if the email can't be scheduled", async () => {
    const { resend } = fakeResend({ sendError: true });
    await expect(decide({ evaluationId: evId, action: "decline" }, deps(resend))).rejects.toThrow(DecisionError);
    const [ev] = await db.select().from(evaluations).where(eq(evaluations.id, evId));
    expect(ev.pipelineStatus).toBe("scored");
    const [d] = await db.select().from(decisions).where(eq(decisions.evaluationId, evId));
    expect(d.undoneAt).not.toBeNull();
  });

  it("enforces the allowed status moves", async () => {
    const { resend } = fakeResend();
    await expect(setStatus(evId, "offer", deps(resend))).rejects.toThrow(/Cannot move/);
    await decide({ evaluationId: evId, action: "decline" }, deps(resend));
    await expect(decide({ evaluationId: evId, action: "advance" }, deps(resend))).rejects.toThrow();
  });

  it("'Not sure' needs a role title for the email", async () => {
    await db.update(evaluations).set({ roleApplied: "NOT_SURE" }).where(eq(evaluations.id, evId));
    const { resend, sent } = fakeResend();
    await expect(decide({ evaluationId: evId, action: "decline" }, deps(resend))).rejects.toThrow(/role title/);
    await decide({ evaluationId: evId, action: "decline", roleTitle: "SPM" }, deps(resend));
    expect(sent[0].payload.subject).toBe("Your application for Senior Product Manager at Kargo");
  });
});

describe("undo", () => {
  it("cancels the scheduled send, removes the decision and allows deciding again", async () => {
    const { resend, sent, cancelled } = fakeResend();
    const { decision } = await decide({ evaluationId: evId, action: "decline" }, deps(resend));
    expect(await undo(decision.id, deps(resend))).toEqual({ ok: true });
    expect(cancelled).toEqual(["re_1"]);
    const [mail] = await db.select().from(emails).where(eq(emails.decisionId, decision.id));
    expect(mail.status).toBe("cancelled");
    const [ev] = await db.select().from(evaluations).where(eq(evaluations.id, evId));
    expect(ev.pipelineStatus).toBe("scored");
    // An undone decision can never send.
    expect(await sendForDecision(decision.id, "decline", deps(resend))).toMatchObject({ ok: false, reason: "decision_undone" });
    // And Arjun can decide again.
    await decide({ evaluationId: evId, action: "advance" }, deps(resend));
    expect(sent).toHaveLength(2);
  });

  it("undo race: if Resend already sent it, mark it sent and refuse", async () => {
    const { resend } = fakeResend({ cancelFails: true, lastEvent: "delivered" });
    const { decision } = await decide({ evaluationId: evId, action: "advance" }, deps(resend));
    expect(await undo(decision.id, deps(resend))).toMatchObject({ ok: false, reason: "already_sent" });
    const [mail] = await db.select().from(emails).where(eq(emails.decisionId, decision.id));
    expect(mail.status).toBe("sent");
    const [ev] = await db.select().from(evaluations).where(eq(evaluations.id, evId));
    expect(ev.pipelineStatus).toBe("advanced");
  });

  it("cancelDecisionEmails never touches an email that already went out", async () => {
    const { resend, cancelled } = fakeResend();
    const { decision } = await decide({ evaluationId: evId, action: "advance" }, deps(resend));
    await db.update(emails).set({ status: "delivered" }).where(eq(emails.decisionId, decision.id));
    expect(await cancelDecisionEmails(decision.id, deps(resend))).toEqual({ ok: true, cancelled: 0 });
    expect(await undo(decision.id, deps(resend))).toMatchObject({ ok: false, reason: "already_sent" });
    expect(cancelled).toEqual([]);
  });
});

describe("webhook events", () => {
  it("a bounce marks the email and flags the candidate; statuses never move backwards", async () => {
    const { resend } = fakeResend();
    await decide({ evaluationId: evId, action: "advance" }, deps(resend));
    await applyEmailEvent(db, "email.bounced", "re_1");
    await applyEmailEvent(db, "email.sent", "re_1"); // late event
    const [mail] = await db.select().from(emails).where(eq(emails.resendId, "re_1"));
    expect(mail.status).toBe("bounced");
    const [ev] = await db.select().from(evaluations).where(eq(evaluations.id, evId));
    expect(ev.flags).toContain("BOUNCED");
  });

  it("ignores events for emails that aren't ours", async () => {
    await expect(applyEmailEvent(db, "email.delivered", "re_unknown")).resolves.toBeUndefined();
  });
});

describe("past-due emails", () => {
  it("an email past its send time no longer blocks a new decision", async () => {
    const { resend } = fakeResend();
    await decide({ evaluationId: evId, action: "advance" }, deps(resend));
    const later = { db, resend, now: () => new Date(NOW.getTime() + 60 * 60_000) };
    await expect(decide({ evaluationId: evId, action: "decline" }, later)).resolves.toBeTruthy();
  });

  it("undo treats a send Resend reports as failed like a cancellation", async () => {
    const { resend } = fakeResend({ cancelFails: true, lastEvent: "failed" });
    const { decision } = await decide({ evaluationId: evId, action: "advance" }, deps(resend));
    expect(await undo(decision.id, deps(resend))).toEqual({ ok: true });
  });
});
