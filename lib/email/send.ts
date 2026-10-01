import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { Resend } from "resend";
import type { PoolConfig } from "@/lib/config/defaults";
import type { Db } from "@/lib/db/client";
import { candidates, decisions, emails, evaluations, pools } from "@/lib/db/schema";
import { log } from "@/lib/log";
import { firstName, renderAdvance, renderDecline, renderDigest, renderHold, renderNudge, type DigestData, type Rendered, type RoleTitle } from "./templates";

// PRD Step 11, "the Cut". Every Resend call in the codebase is in this file (ESLint enforces
// it). A candidate email exists only for a decision that exists, is not undone and matches
// the kind, and that is checked twice: when the email is scheduled and again at send time.
// The DB unique index on (decision_id, kind) is the real guard; the Resend Idempotency-Key
// `${decisionId}:${kind}` covers retries of the same send. The only email without a
// decision is Arjun's digest, and it can only go to ARJUN_EMAIL.
//
// Scheduling is done here, not by Resend: Resend's scheduled sends fail on this account
// while immediate sends are delivered (verified 30 Sep 2026). An email waits in `emails`
// with status `scheduled` until `scheduled_at`; sendDueEmails() then sends it immediately.
// Undo and send each move the row out of `scheduled` with one conditional UPDATE, so
// exactly one of them can win.

export type CandidateKind = "advance" | "decline" | "hold" | "nudge";

/** The subset of the Resend SDK we use; tests pass a fake. */
export type ResendLike = {
  emails: { send: Resend["emails"]["send"]; get: Resend["emails"]["get"] };
  webhooks: { verify: Resend["webhooks"]["verify"] };
};

let client: ResendLike | null = null;
export function resendClient(): ResendLike {
  if (!client) {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error("RESEND_API_KEY is not set");
    client = new Resend(key);
  }
  return client;
}

type Refusal = "no_decision" | "decision_undone" | "wrong_kind" | "not_eligible" | "no_contact" | "already_sent" | "config" | "resend_error";
export type SendResult = { ok: true; emailId: string; scheduledAt: Date } | { ok: false; reason: Refusal; detail?: string };

type Deps = { db: Db; resend?: ResendLike; now?: () => Date };

class ConfigError extends Error {}
function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new ConfigError(`${name} is not set`);
  return v;
}

const ACTION_OF: Record<Exclude<CandidateKind, "nudge">, "advance" | "decline" | "hold"> = { advance: "advance", decline: "decline", hold: "hold" };

type Context = {
  d: typeof decisions.$inferSelect;
  ev: typeof evaluations.$inferSelect;
  cand: typeof candidates.$inferSelect;
  pool: typeof pools.$inferSelect;
};

// ---- the guard (runs at schedule time and again at send time) ----
async function guard(db: Db, decisionId: string, kind: CandidateKind, atSendTime = false): Promise<{ ok: true; ctx: Context } | { ok: false; reason: Refusal; detail?: string }> {
  const [row] = await db
    .select({ d: decisions, ev: evaluations, cand: candidates, pool: pools })
    .from(decisions)
    .innerJoin(evaluations, eq(evaluations.id, decisions.evaluationId))
    .innerJoin(candidates, eq(candidates.id, evaluations.candidateId))
    .innerJoin(pools, eq(pools.id, evaluations.poolId))
    .where(eq(decisions.id, decisionId));
  if (!row) return { ok: false, reason: "no_decision" };
  const { d, ev, cand } = row;
  if (d.undoneAt) return { ok: false, reason: "decision_undone" };
  if (kind === "nudge") {
    if (d.action !== "advance") return { ok: false, reason: "wrong_kind" };
    if (ev.pipelineStatus !== "advanced") return { ok: false, reason: "not_eligible", detail: "candidate is no longer in Advanced (booked or moved on)" };
    if (!atSendTime) {
      const [adv] = await db.select().from(emails).where(and(eq(emails.decisionId, decisionId), eq(emails.kind, "advance")));
      if (!adv || !["sent", "delivered"].includes(adv.status)) return { ok: false, reason: "not_eligible", detail: "the invite was not delivered" };
    }
  } else if (d.action !== ACTION_OF[kind]) {
    return { ok: false, reason: "wrong_kind" };
  }
  if (!cand.email || cand.noContact) return { ok: false, reason: "no_contact" };
  return { ok: true, ctx: row };
}

// ---- content: fixed templates only ----
function render({ d, ev, cand }: Context, kind: CandidateKind): Rendered {
  const roleTitle = (ev.roleTitleFinal ?? (ev.roleApplied === "SPM" ? "SPM" : "PM")) as RoleTitle;
  const common = { firstName: firstName(cand.displayName), roleTitle, legacy: cand.legacy };
  if (kind === "advance") {
    return renderAdvance({ ...common, inviteLine: d.inviteLineFinal ?? "", bookingUrl: env("BOOKING_URL"), askRelocation: cand.eligibilityRelocate === "unstated" });
  }
  if (kind === "decline") return renderDecline(common);
  if (kind === "hold") {
    if (!d.holdUntil) throw new ConfigError("hold decision without a date");
    return renderHold({ ...common, holdUntil: d.holdUntil });
  }
  return renderNudge({ firstName: common.firstName, roleTitle, bookingUrl: env("BOOKING_URL") });
}

function delayMinutes(kind: CandidateKind, config: PoolConfig): number {
  return kind === "nudge" ? 0 : config.sendDelayMinutes[kind];
}

/**
 * Schedules the email for a decision: Advance +10 min, Hold +10 min, Decline +24 h, nudge
 * now. Nothing reaches Resend until it is due (or, for a nudge, straight away).
 */
export async function sendForDecision(decisionId: string, kind: CandidateKind, deps: Deps): Promise<SendResult> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const g = await guard(db, decisionId, kind);
  if (!g.ok) return g;
  try {
    render(g.ctx, kind); // fail now, not at send time, if config is missing
    env("EMAIL_FROM");
    env("ARJUN_EMAIL");
  } catch (err) {
    if (err instanceof ConfigError) return { ok: false, reason: "config", detail: err.message };
    throw err;
  }

  const scheduledAt = new Date(now.getTime() + delayMinutes(kind, g.ctx.pool.configJson as PoolConfig) * 60_000);
  const idempotencyKey = `${decisionId}:${kind}`;
  let [row] = await db
    .insert(emails)
    .values({ decisionId, evaluationId: g.ctx.ev.id, kind, idempotencyKey, scheduledAt, status: "scheduled" })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    // The (decision, kind) slot is taken. Only an attempt that explicitly failed and never
    // reached Resend may be rescheduled; it keeps the same idempotency key.
    [row] = await db
      .update(emails)
      .set({ status: "scheduled", scheduledAt })
      .where(and(eq(emails.decisionId, decisionId), eq(emails.kind, kind), eq(emails.status, "failed"), isNull(emails.resendId)))
      .returning();
    if (!row) return { ok: false, reason: "already_sent" };
  }
  log("email.scheduled", { emailId: row.id, kind });
  if (kind === "nudge") await sendDueEmails({ ...deps, onlyId: row.id });
  return { ok: true, emailId: row.id, scheduledAt };
}

/**
 * Sends every candidate email whose time has come. Safe to call from many places at once
 * (dashboard, cron, scheduler): each row is claimed with a single conditional UPDATE.
 */
export async function sendDueEmails(deps: Deps & { limit?: number; onlyId?: string }): Promise<number> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const resend = deps.resend ?? resendClient();
  const stuck = new Date(now.getTime() - 10 * 60_000); // a send that crashed mid-way
  const due = or(
    and(eq(emails.status, "scheduled"), lte(emails.scheduledAt, now)),
    and(eq(emails.status, "pending"), isNull(emails.resendId), lt(emails.scheduledAt, stuck)),
  );
  const candidatesDue = await db
    .select({ id: emails.id })
    .from(emails)
    .where(and(isNotNull(emails.decisionId), due, deps.onlyId ? eq(emails.id, deps.onlyId) : undefined))
    .orderBy(asc(emails.scheduledAt))
    .limit(deps.limit ?? 25);

  let sent = 0;
  for (const { id } of candidatesDue) {
    // Claiming stamps scheduled_at with the attempt time, so "stuck" is measured from the
    // claim (not the original due time) and a slow sender is never treated as crashed.
    const [claimed] = await db.update(emails).set({ status: "pending", scheduledAt: now }).where(and(eq(emails.id, id), due)).returning();
    if (!claimed) continue; // someone else (or Undo) got there first

    // Check again at send time: the decision may have been undone, or the candidate booked.
    const g = await guard(db, claimed.decisionId!, claimed.kind as CandidateKind, true);
    if (!g.ok) {
      await db.update(emails).set({ status: "cancelled" }).where(eq(emails.id, id));
      log("email.dropped", { emailId: id, reason: g.reason });
      continue;
    }
    let rendered: Rendered;
    try {
      rendered = render(g.ctx, claimed.kind as CandidateKind);
    } catch {
      await db.update(emails).set({ status: "failed" }).where(eq(emails.id, id));
      continue;
    }
    const r = await deliver(db, resend, id, { to: process.env.EMAIL_REDIRECT_TO || g.ctx.cand.email!, rendered, idempotencyKey: claimed.idempotencyKey }, now);
    if (r === "sent") sent++;
  }
  return sent;
}

/** B.6: Arjun's digest. The only email without a decision; the recipient is fixed. Sent now. */
export async function sendDigest(date: string, data: DigestData, deps: Deps): Promise<{ ok: true } | { ok: false; reason: Refusal; detail?: string }> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  let to: string;
  try {
    to = env("ARJUN_EMAIL");
  } catch (err) {
    return { ok: false, reason: "config", detail: (err as Error).message };
  }
  const idempotencyKey = `digest:${date}`;
  const [row] = await db.insert(emails).values({ kind: "digest", idempotencyKey, status: "pending", scheduledAt: now }).onConflictDoNothing().returning();
  if (!row) return { ok: false, reason: "already_sent" };
  const r = await deliver(db, deps.resend ?? resendClient(), row.id, { to, rendered: renderDigest(data), idempotencyKey }, now);
  return r === "sent" ? { ok: true } : { ok: false, reason: "resend_error" };
}

/** The single place an email leaves the system. Immediate send only. */
async function deliver(db: Db, resend: ResendLike, emailId: string, msg: { to: string; rendered: Rendered; idempotencyKey: string }, now: Date): Promise<"sent" | "retry" | "failed"> {
  let from: string;
  let replyTo: string;
  try {
    from = env("EMAIL_FROM");
    replyTo = env("ARJUN_EMAIL");
  } catch {
    await db.update(emails).set({ status: "failed" }).where(and(eq(emails.id, emailId), isNull(emails.resendId)));
    return "failed";
  }
  let result: Awaited<ReturnType<ResendLike["emails"]["send"]>>;
  try {
    result = await resend.emails.send(
      { from, to: msg.to, replyTo, subject: msg.rendered.subject, text: msg.rendered.text, html: msg.rendered.html },
      { idempotencyKey: msg.idempotencyKey },
    );
  } catch {
    result = { data: null, error: { name: "application_error", message: "network error", statusCode: 503 } } as never;
  }
  const { data, error } = result;
  if (data && !error) {
    await db.update(emails).set({ resendId: data.id, status: "sent" }).where(eq(emails.id, emailId));
    log("email.sent", { emailId });
    return "sent";
  }
  const status = (error as { statusCode?: number } | null)?.statusCode ?? 0;
  if (status === 429 || status >= 500 || status === 409) {
    // Rate limit, Resend outage, or the same key still in flight: try again in 5 minutes.
    await db
      .update(emails)
      .set({ status: "scheduled", scheduledAt: new Date(now.getTime() + 5 * 60_000) })
      .where(and(eq(emails.id, emailId), isNull(emails.resendId)));
    log("email.retry", { emailId, status });
    return "retry";
  }
  await db.update(emails).set({ status: "failed" }).where(and(eq(emails.id, emailId), isNull(emails.resendId)));
  log("email.failed", { emailId, error: error?.name ?? "unknown" });
  return "failed";
}

export type CancelResult = { ok: true; cancelled: number } | { ok: false; reason: "already_sent" };

/**
 * Undo (PRD Step 11): stop every not-yet-sent email of this decision. One conditional
 * UPDATE per call: if the sender has already claimed the row, Undo loses and says so.
 */
export async function cancelDecisionEmails(decisionId: string, deps: Deps): Promise<CancelResult> {
  const { db } = deps;
  const cancelled = await db
    .update(emails)
    .set({ status: "cancelled" })
    .where(and(eq(emails.decisionId, decisionId), inArray(emails.status, ["scheduled", "failed"]), isNull(emails.resendId)))
    .returning({ id: emails.id });
  const [gone] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(emails)
    .where(and(eq(emails.decisionId, decisionId), inArray(emails.status, ["pending", "sent", "delivered", "bounced"])));
  if (gone.n > 0) return { ok: false, reason: "already_sent" };
  return { ok: true, cancelled: cancelled.length };
}

/** Backstop for missed webhooks: ask Resend what happened to sent emails. Forward only. */
export async function syncSentEmails(deps: Deps & { limit?: number }): Promise<number> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const resend = deps.resend ?? resendClient();
  const rows = await db
    .select()
    .from(emails)
    .where(and(eq(emails.status, "sent"), isNotNull(emails.resendId), lt(emails.scheduledAt, new Date(now.getTime() - 10 * 60_000))))
    .limit(deps.limit ?? 50);
  const MAP: Record<string, "delivered" | "bounced" | "failed"> = {
    delivered: "delivered",
    opened: "delivered",
    clicked: "delivered",
    complained: "delivered",
    bounced: "bounced",
    failed: "failed",
    suppressed: "failed",
  };
  let updated = 0;
  for (const e of rows) {
    const { data } = await resend.emails.get(e.resendId!);
    const next = data ? MAP[data.last_event] : undefined;
    if (!next) continue;
    await db.update(emails).set({ status: next }).where(and(eq(emails.id, e.id), eq(emails.status, "sent")));
    updated++;
  }
  return updated;
}

/** Svix signature check on the raw body (PRD Step 12). Throws if invalid. */
export function verifyWebhook(rawBody: string, headers: { id: string; timestamp: string; signature: string }, resend?: ResendLike) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) throw new Error("RESEND_WEBHOOK_SECRET is not set");
  return (resend ?? webhookVerifier()).webhooks.verify({ payload: rawBody, headers, webhookSecret: secret });
}

// Verification needs no API key; this instance never sends anything.
let verifier: ResendLike | null = null;
function webhookVerifier(): ResendLike {
  verifier ??= new Resend(process.env.RESEND_API_KEY || "re_verify_only");
  return verifier;
}
