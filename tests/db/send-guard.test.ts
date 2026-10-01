import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { candidates, decisions, emails, evaluations, pools } from "@/lib/db/schema";
import { defaultConfig } from "@/lib/config/defaults";
import { decide, DecisionError, setStatus, undo } from "@/lib/decisions";
import { cancelDecisionEmails, sendDigest, sendDueEmails, sendForDecision, type ResendLike } from "@/lib/email/send";
import { applyEmailEvent } from "@/lib/email/events";
import { PRIVACY_FOOTER } from "@/lib/email/templates";
import { testDb } from "./helpers";

// The Cut (PRD Step 11): proven here, not just asserted in comments.
// Emails wait in the database until due; sendDueEmails() hands them to Resend immediately.

type Sent = { payload: Record<string, unknown>; key?: string };
function fakeResend(opts: { error?: { statusCode: number; name: string }; delayMs?: number } = {}) {
  const sent: Sent[] = [];
  const byKey = new Map<string, string>();
  let n = 0;
  const resend = {
    emails: {
      send: async (payload: Record<string, unknown>, options?: { idempotencyKey?: string }) => {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        if (opts.error) return { data: null, error: { ...opts.error, message: "x" } };
        const key = options?.idempotencyKey;
        if (key && byKey.has(key)) return { data: { id: byKey.get(key)! }, error: null }; // Resend dedupes
        const id = `re_${++n}`;
        if (key) byKey.set(key, id);
        sent.push({ payload, key });
        return { data: { id }, error: null };
      },
      get: async () => ({ data: { last_event: "delivered" }, error: null }),
    },
    webhooks: { verify: () => ({}) },
  } as unknown as ResendLike;
  return { resend, sent };
}

let db: Db;
let evId: string;
let poolId: string;
const NOW = new Date("2026-10-01T09:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

async function seed(opts: { email?: string | null; legacy?: boolean } = {}) {
  const [cand] = await db
    .insert(candidates)
    .values({
      poolId,
      displayName: "PRIYA RAGHAVAN",
      email: opts.email === undefined ? "priya@example.com" : opts.email,
      noContact: opts.email === null,
      legacy: opts.legacy ?? false,
      eligibilityRelocate: "unstated",
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
      briefJson: { invite_line: "Your gate check-in redesign stood out.", why_ranked_here: "AI SUMMARY TEXT" },
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

const deps = (resend: ResendLike, minutes = 0) => ({ db, resend, now: () => at(minutes) });

describe("sendForDecision: refuses without a valid decision", () => {
  it("refuses when the decision does not exist", async () => {
    const { resend, sent } = fakeResend();
    expect(await sendForDecision("00000000-0000-0000-0000-000000000000", "decline", deps(resend))).toMatchObject({ ok: false, reason: "no_decision" });
    await sendDueEmails(deps(resend, 2000));
    expect(sent).toHaveLength(0);
  });

  it("refuses a kind that doesn't match the decision (an Advance can't send a Decline)", async () => {
    const { resend } = fakeResend();
    const [d] = await db.insert(decisions).values({ evaluationId: evId, action: "advance", prevPipelineStatus: "scored" }).returning();
    expect(await sendForDecision(d.id, "decline", deps(resend))).toMatchObject({ ok: false, reason: "wrong_kind" });
    expect(await sendForDecision(d.id, "hold", deps(resend))).toMatchObject({ ok: false, reason: "wrong_kind" });
  });

  it("refuses an undone decision", async () => {
    const { resend } = fakeResend();
    const [d] = await db.insert(decisions).values({ evaluationId: evId, action: "decline", prevPipelineStatus: "scored", undoneAt: NOW }).returning();
    expect(await sendForDecision(d.id, "decline", deps(resend))).toMatchObject({ ok: false, reason: "decision_undone" });
  });

  it("checks again at send time: an email whose decision was undone in the meantime never goes out", async () => {
    const { resend, sent } = fakeResend();
    const [d] = await db.insert(decisions).values({ evaluationId: evId, action: "decline", prevPipelineStatus: "scored" }).returning();
    await sendForDecision(d.id, "decline", deps(resend));
    await db.update(decisions).set({ undoneAt: NOW }).where(eq(decisions.id, d.id)); // bypassing Undo on purpose
    expect(await sendDueEmails(deps(resend, 2000))).toBe(0);
    expect(sent).toHaveLength(0);
    const [m] = await db.select().from(emails).where(eq(emails.decisionId, d.id));
    expect(m.status).toBe("cancelled");
  });

  it("the database refuses a candidate email row without a decision", async () => {
    await expect(db.insert(emails).values({ evaluationId: evId, kind: "decline", idempotencyKey: "x" })).rejects.toThrow();
  });
});

describe("timing and exactly-once", () => {
  it("nothing is sent before the due time; Advance +10 min, Hold +10 min, Decline +24 h", async () => {
    const { resend, sent } = fakeResend();
    const e2 = await seed();
    const e3 = await seed();
    await decide({ evaluationId: evId, action: "advance" }, deps(resend));
    await decide({ evaluationId: e2, action: "decline" }, deps(resend));
    await decide({ evaluationId: e3, action: "hold", holdUntil: "2026-10-22" }, deps(resend));
    const rows = await db.select().from(emails);
    expect(Object.fromEntries(rows.map((r) => [r.kind, r.scheduledAt!.toISOString()]))).toEqual({
      advance: "2026-10-01T09:10:00.000Z",
      hold: "2026-10-01T09:10:00.000Z",
      decline: "2026-10-02T09:00:00.000Z",
    });
    expect(await sendDueEmails(deps(resend, 9))).toBe(0);
    expect(await sendDueEmails(deps(resend, 10))).toBe(2);
    expect(await sendDueEmails(deps(resend, 1439))).toBe(0);
    expect(await sendDueEmails(deps(resend, 1440))).toBe(1);
    expect(sent.map((s) => s.payload.subject)).toEqual([
      "Next step: Product Manager at Kargo",
      "Update on your application: Product Manager at Kargo",
      "Your application for Product Manager at Kargo",
    ]);
    for (const s of sent) expect(s.payload).toMatchObject({ replyTo: "arjun@example.com", from: "Arjun at Kargo <onboarding@resend.dev>" });
    for (const s of sent) expect(s.payload.scheduledAt).toBeUndefined(); // immediate send only
  });

  it("a second schedule for the same decision and kind is refused, and it sends once", async () => {
    const { resend, sent } = fakeResend();
    const [d] = await db.insert(decisions).values({ evaluationId: evId, action: "decline", prevPipelineStatus: "scored" }).returning();
    expect((await sendForDecision(d.id, "decline", deps(resend))).ok).toBe(true);
    expect(await sendForDecision(d.id, "decline", deps(resend))).toMatchObject({ ok: false, reason: "already_sent" });
    await sendDueEmails(deps(resend, 2000));
    await sendDueEmails(deps(resend, 3000));
    expect(sent).toHaveLength(1);
    expect(sent[0].key).toBe(`${d.id}:decline`);
  });

  it("concurrent schedules make one row; concurrent senders make one send", async () => {
    const { resend, sent } = fakeResend({ delayMs: 20 });
    const [d] = await db.insert(decisions).values({ evaluationId: evId, action: "decline", prevPipelineStatus: "scored" }).returning();
    const results = await Promise.all(Array.from({ length: 5 }, () => sendForDecision(d.id, "decline", deps(resend))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const senders = await Promise.all(Array.from({ length: 5 }, () => sendDueEmails(deps(resend, 2000))));
    expect(senders.reduce((a, b) => a + b, 0)).toBe(1);
    expect(sent).toHaveLength(1);
    const rows = await db.select().from(emails).where(eq(emails.decisionId, d.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("sent");
  });

  it("a rate limit or outage retries in 5 minutes with the same key; a hard error fails", async () => {
    const [d] = await db.insert(decisions).values({ evaluationId: evId, action: "decline", prevPipelineStatus: "scored" }).returning();
    await sendForDecision(d.id, "decline", deps(fakeResend().resend));
    const limited = fakeResend({ error: { statusCode: 429, name: "rate_limit_exceeded" } });
    expect(await sendDueEmails(deps(limited.resend, 1440))).toBe(0);
    let [m] = await db.select().from(emails).where(eq(emails.decisionId, d.id));
    expect(m).toMatchObject({ status: "scheduled" });
    expect(m.scheduledAt!.toISOString()).toBe(at(1445).toISOString());
    const ok = fakeResend();
    expect(await sendDueEmails(deps(ok.resend, 1445))).toBe(1);
    expect(ok.sent[0].key).toBe(`${d.id}:decline`);

    const e2 = await seed();
    const [d2] = await db.insert(decisions).values({ evaluationId: e2, action: "decline", prevPipelineStatus: "scored" }).returning();
    await sendForDecision(d2.id, "decline", deps(ok.resend));
    await sendDueEmails(deps(fakeResend({ error: { statusCode: 422, name: "validation_error" } }).resend, 1440));
    [m] = await db.select().from(emails).where(eq(emails.decisionId, d2.id));
    expect(m.status).toBe("failed");
    // An explicitly failed email may be rescheduled (same key); nothing else may.
    expect((await sendForDecision(d2.id, "decline", deps(ok.resend))).ok).toBe(true);
  });

  it("no email address → nothing is scheduled (NO_CONTACT)", async () => {
    const id = await seed({ email: null });
    const { resend } = fakeResend();
    const [d] = await db.insert(decisions).values({ evaluationId: id, action: "decline", prevPipelineStatus: "scored" }).returning();
    expect(await sendForDecision(d.id, "decline", deps(resend))).toMatchObject({ ok: false, reason: "no_contact" });
    expect(await db.select().from(emails).where(eq(emails.decisionId, d.id))).toHaveLength(0);
  });
});

describe("what gets sent", () => {
  it("the Decline contains zero AI text: exactly the fixed template", async () => {
    const { resend, sent } = fakeResend();
    await decide({ evaluationId: evId, action: "decline" }, deps(resend));
    await sendDueEmails(deps(resend, 1440));
    const text = sent[0].payload.text as string;
    expect(text).not.toContain("gate check-in");
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

  it("the Advance carries only Arjun's approved line, the booking link and the relocation question", async () => {
    const { resend, sent } = fakeResend();
    await decide({ evaluationId: evId, action: "advance", inviteLineOverride: "Loved your yard-management work." }, deps(resend));
    await sendDueEmails(deps(resend, 10));
    const text = sent[0].payload.text as string;
    expect(text).toContain("Loved your yard-management work.");
    expect(text).not.toContain("gate check-in");
    expect(text).toContain("https://cal.example.com/arjun");
    expect(text).toContain("relocation is something you'd consider");
  });

  it("legacy candidates get the apology opening", async () => {
    const id = await seed({ legacy: true });
    const { resend, sent } = fakeResend();
    await decide({ evaluationId: id, action: "hold", holdUntil: "2026-10-22" }, deps(resend));
    await sendDueEmails(deps(resend, 10));
    expect(sent[0].payload.text).toContain("Apologies for how long it has taken us to get back to you. Thank you for applying");
    expect(sent[0].payload.text).toContain("by 22 October 2026");
  });

  it("EMAIL_REDIRECT_TO sends every candidate email to the test inbox instead", async () => {
    process.env.EMAIL_REDIRECT_TO = "tester@example.com";
    const { resend, sent } = fakeResend();
    await decide({ evaluationId: evId, action: "decline" }, deps(resend));
    await sendDueEmails(deps(resend, 1440));
    expect(sent[0].payload.to).toBe("tester@example.com");
  });

  it("the digest goes only to ARJUN_EMAIL, immediately, once per day", async () => {
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
  it("only for a non-undone Advance whose invite went out and who has not booked; sent at once", async () => {
    const { resend, sent } = fakeResend();
    const { decision } = await decide({ evaluationId: evId, action: "advance" }, deps(resend));
    expect(await sendForDecision(decision.id, "nudge", deps(resend))).toMatchObject({ ok: false, reason: "not_eligible" });
    await sendDueEmails(deps(resend, 10));
    expect((await sendForDecision(decision.id, "nudge", deps(resend, 4400))).ok).toBe(true);
    expect(await sendForDecision(decision.id, "nudge", deps(resend, 5000))).toMatchObject({ ok: false, reason: "already_sent" });
    expect(sent.map((s) => s.key)).toEqual([`${decision.id}:advance`, `${decision.id}:nudge`]);
  });

  it("never after the candidate booked", async () => {
    const { resend } = fakeResend();
    const { decision } = await decide({ evaluationId: evId, action: "advance" }, deps(resend));
    await sendDueEmails(deps(resend, 10));
    await setStatus(evId, "booked", deps(resend));
    expect(await sendForDecision(decision.id, "nudge", deps(resend, 4400))).toMatchObject({ ok: false, reason: "not_eligible" });
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
    const { resend, sent } = fakeResend();
    const results = await Promise.allSettled([decide({ evaluationId: evId, action: "advance" }, deps(resend)), decide({ evaluationId: evId, action: "advance" }, deps(resend))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(decisions).where(eq(decisions.evaluationId, evId))).toHaveLength(1);
    await sendDueEmails(deps(resend, 10));
    expect(sent).toHaveLength(1);
  });

  it("refuses a new decision while an email is still waiting, allows it once sent", async () => {
    const { resend } = fakeResend();
    await decide({ evaluationId: evId, action: "advance" }, deps(resend));
    await expect(decide({ evaluationId: evId, action: "decline" }, deps(resend, 60))).rejects.toThrow(/Undo it first/);
    await sendDueEmails(deps(resend, 60));
    await expect(decide({ evaluationId: evId, action: "decline" }, deps(resend, 61))).resolves.toBeTruthy();
  });

  it("rolls the decision back if the email can't be scheduled", async () => {
    delete process.env.EMAIL_FROM;
    const { resend } = fakeResend();
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
    await sendDueEmails(deps(resend, 1440));
    expect(sent[0].payload.subject).toBe("Your application for Senior Product Manager at Kargo");
  });
});

describe("undo", () => {
  it("stops the email, removes the decision and allows deciding again", async () => {
    const { resend, sent } = fakeResend();
    const { decision } = await decide({ evaluationId: evId, action: "decline" }, deps(resend));
    expect(await undo(decision.id, deps(resend, 5))).toEqual({ ok: true });
    const [mail] = await db.select().from(emails).where(eq(emails.decisionId, decision.id));
    expect(mail.status).toBe("cancelled");
    const [ev] = await db.select().from(evaluations).where(eq(evaluations.id, evId));
    expect(ev.pipelineStatus).toBe("scored");
    expect(await sendDueEmails(deps(resend, 2000))).toBe(0); // never goes out
    expect(await sendForDecision(decision.id, "decline", deps(resend))).toMatchObject({ ok: false, reason: "decision_undone" });
    await decide({ evaluationId: evId, action: "advance" }, deps(resend, 6));
    await sendDueEmails(deps(resend, 16));
    expect(sent.map((s) => s.payload.subject)).toEqual(["Next step: Product Manager at Kargo"]);
  });

  it("Undo and send race: whichever claims the row first wins, never both", async () => {
    const { resend } = fakeResend();
    const { decision } = await decide({ evaluationId: evId, action: "advance" }, deps(resend));
    // The sender has claimed it (handing it to Resend right now):
    await db.update(emails).set({ status: "pending" }).where(eq(emails.decisionId, decision.id));
    expect(await undo(decision.id, deps(resend, 10))).toMatchObject({ ok: false, reason: "already_sent" });
    expect(await cancelDecisionEmails(decision.id, deps(resend))).toMatchObject({ ok: false, reason: "already_sent" });
    const [ev] = await db.select().from(evaluations).where(eq(evaluations.id, evId));
    expect(ev.pipelineStatus).toBe("advanced");
  });

  it("after it has been sent, Undo says so", async () => {
    const { resend } = fakeResend();
    const { decision } = await decide({ evaluationId: evId, action: "advance" }, deps(resend));
    await sendDueEmails(deps(resend, 10));
    expect(await undo(decision.id, deps(resend, 11))).toMatchObject({ ok: false, reason: "already_sent" });
  });
});

describe("webhook events", () => {
  it("a bounce marks the email and flags the candidate; statuses never move backwards", async () => {
    const { resend } = fakeResend();
    await decide({ evaluationId: evId, action: "advance" }, deps(resend));
    await sendDueEmails(deps(resend, 10));
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

describe("crash recovery", () => {
  it("a send left 'pending' by a crashed function is retried after 10 minutes, with the same key", async () => {
    const { resend, sent } = fakeResend();
    const [d] = await db.insert(decisions).values({ evaluationId: evId, action: "decline", prevPipelineStatus: "scored" }).returning();
    await sendForDecision(d.id, "decline", deps(resend));
    // Simulate a sender that claimed it at +1440 and died before calling Resend.
    await db.update(emails).set({ status: "pending", scheduledAt: at(1440) }).where(eq(emails.decisionId, d.id));
    expect(await sendDueEmails(deps(resend, 1445))).toBe(0); // still within its window
    expect(await sendDueEmails(deps(resend, 1451))).toBe(1);
    expect(sent[0].key).toBe(`${d.id}:decline`);
  });
});
