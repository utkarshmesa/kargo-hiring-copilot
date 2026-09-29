import { and, eq, inArray, isNull } from "drizzle-orm";
import { Resend } from "resend";
import type { PoolConfig } from "@/lib/config/defaults";
import type { Db } from "@/lib/db/client";
import { candidates, decisions, emails, evaluations, pools } from "@/lib/db/schema";
import { log } from "@/lib/log";
import { firstName, renderAdvance, renderDecline, renderDigest, renderHold, renderNudge, type DigestData, type Rendered, type RoleTitle } from "./templates";

// PRD Step 11, "the Cut". Every Resend call in the codebase is in this file (ESLint enforces
// it). A candidate email is sent only for a decision that exists, is not undone and matches
// the kind. The DB unique index on (decision_id, kind) is the real guard; the Resend
// Idempotency-Key `${decisionId}:${kind}` covers retries of the same call. The only email
// without a decision is Arjun's digest, and it can only go to ARJUN_EMAIL.

export type CandidateKind = "advance" | "decline" | "hold" | "nudge";

/** The subset of the Resend SDK we use; tests pass a fake. */
export type ResendLike = {
  emails: {
    send: Resend["emails"]["send"];
    cancel: Resend["emails"]["cancel"];
    get: Resend["emails"]["get"];
  };
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

export type SendResult =
  | { ok: true; emailId: string; resendId: string; scheduledAt: Date | null }
  | { ok: false; reason: "no_decision" | "decision_undone" | "wrong_kind" | "not_eligible" | "no_contact" | "already_sent" | "config" | "resend_error"; detail?: string };

type Deps = { db: Db; resend?: ResendLike; now?: () => Date };

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new ConfigError(`${name} is not set`);
  return v;
}
class ConfigError extends Error {}

const ACTION_OF: Record<Exclude<CandidateKind, "nudge">, "advance" | "decline" | "hold"> = { advance: "advance", decline: "decline", hold: "hold" };

export async function sendForDecision(decisionId: string, kind: CandidateKind, deps: Deps): Promise<SendResult> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();

  // ---- the guard ----
  const [row] = await db
    .select({ d: decisions, ev: evaluations, cand: candidates, pool: pools })
    .from(decisions)
    .innerJoin(evaluations, eq(evaluations.id, decisions.evaluationId))
    .innerJoin(candidates, eq(candidates.id, evaluations.candidateId))
    .innerJoin(pools, eq(pools.id, evaluations.poolId))
    .where(eq(decisions.id, decisionId));
  if (!row) return { ok: false, reason: "no_decision" };
  const { d, ev, cand, pool } = row;
  if (d.undoneAt) return { ok: false, reason: "decision_undone" };
  if (kind === "nudge") {
    if (d.action !== "advance") return { ok: false, reason: "wrong_kind" };
    if (ev.pipelineStatus !== "advanced") return { ok: false, reason: "not_eligible", detail: "candidate is no longer in Advanced (booked or moved on)" };
    const [adv] = await db.select().from(emails).where(and(eq(emails.decisionId, decisionId), eq(emails.kind, "advance")));
    if (!adv || !["sent", "delivered"].includes(adv.status)) return { ok: false, reason: "not_eligible", detail: "the invite was not delivered" };
  } else if (d.action !== ACTION_OF[kind]) {
    return { ok: false, reason: "wrong_kind" };
  }
  if (!cand.email || cand.noContact) return { ok: false, reason: "no_contact" };

  // ---- content: fixed templates only ----
  let rendered: Rendered;
  let scheduledAt: Date | null;
  try {
    const config = pool.configJson as PoolConfig;
    const roleTitle = (ev.roleTitleFinal ?? (ev.roleApplied === "SPM" ? "SPM" : "PM")) as RoleTitle;
    const common = { firstName: firstName(cand.displayName), roleTitle, legacy: cand.legacy };
    const minutes = (m: number) => new Date(now.getTime() + m * 60_000);
    if (kind === "advance") {
      rendered = renderAdvance({
        ...common,
        inviteLine: d.inviteLineFinal ?? "",
        bookingUrl: env("BOOKING_URL"),
        askRelocation: cand.eligibilityRelocate === "unstated",
      });
      scheduledAt = minutes(config.sendDelayMinutes.advance);
    } else if (kind === "decline") {
      rendered = renderDecline(common);
      scheduledAt = minutes(config.sendDelayMinutes.decline);
    } else if (kind === "hold") {
      if (!d.holdUntil) return { ok: false, reason: "wrong_kind", detail: "hold decision without a date" };
      rendered = renderHold({ ...common, holdUntil: d.holdUntil });
      scheduledAt = minutes(config.sendDelayMinutes.hold);
    } else {
      rendered = renderNudge({ firstName: common.firstName, roleTitle, bookingUrl: env("BOOKING_URL") });
      scheduledAt = null; // sent now; it is already days after the decision
    }
  } catch (err) {
    if (err instanceof ConfigError) return { ok: false, reason: "config", detail: err.message };
    throw err;
  }

  // ---- reserve the (decision, kind) slot before calling Resend ----
  const idempotencyKey = `${decisionId}:${kind}`;
  let emailRow = (
    await db
      .insert(emails)
      .values({ decisionId, evaluationId: ev.id, kind, idempotencyKey, scheduledAt, status: "pending" })
      .onConflictDoNothing()
      .returning()
  )[0];
  if (!emailRow) {
    // Someone already holds this slot. "pending" means another call is sending it right now.
    // Only an attempt that explicitly failed may be retried, with the same idempotency key.
    const [existing] = await db.select().from(emails).where(and(eq(emails.decisionId, decisionId), eq(emails.kind, kind)));
    if (!existing || existing.status !== "failed" || existing.resendId) return { ok: false, reason: "already_sent" };
    emailRow = existing;
  }

  return deliver(db, deps.resend ?? resendClient(), emailRow.id, {
    to: process.env.EMAIL_REDIRECT_TO || cand.email,
    rendered,
    scheduledAt,
    idempotencyKey,
  });
}

/** B.6: Arjun's digest. The only email without a decision; the recipient is fixed. */
export async function sendDigest(date: string, data: DigestData, deps: Deps): Promise<SendResult> {
  const { db } = deps;
  let to: string;
  try {
    to = env("ARJUN_EMAIL");
  } catch (err) {
    return { ok: false, reason: "config", detail: (err as Error).message };
  }
  const idempotencyKey = `digest:${date}`;
  const [row] = await db.insert(emails).values({ kind: "digest", idempotencyKey, status: "pending" }).onConflictDoNothing().returning();
  if (!row) return { ok: false, reason: "already_sent" };
  return deliver(db, deps.resend ?? resendClient(), row.id, { to, rendered: renderDigest(data), scheduledAt: null, idempotencyKey });
}

async function deliver(
  db: Db,
  resend: ResendLike,
  emailId: string,
  msg: { to: string; rendered: Rendered; scheduledAt: Date | null; idempotencyKey: string },
): Promise<SendResult> {
  let from: string;
  let replyTo: string;
  try {
    from = env("EMAIL_FROM");
    replyTo = env("ARJUN_EMAIL");
  } catch (err) {
    await db.update(emails).set({ status: "failed" }).where(and(eq(emails.id, emailId), isNull(emails.resendId)));
    return { ok: false, reason: "config", detail: (err as Error).message };
  }
  const { data, error } = await resend.emails.send(
    {
      from,
      to: msg.to,
      replyTo,
      subject: msg.rendered.subject,
      text: msg.rendered.text,
      html: msg.rendered.html,
      ...(msg.scheduledAt ? { scheduledAt: msg.scheduledAt.toISOString() } : {}),
    },
    { idempotencyKey: msg.idempotencyKey },
  );
  if (error || !data) {
    await db.update(emails).set({ status: "failed" }).where(and(eq(emails.id, emailId), isNull(emails.resendId)));
    log("email.failed", { emailId, error: error?.name ?? "unknown" });
    return { ok: false, reason: "resend_error", detail: error?.message };
  }
  await db
    .update(emails)
    .set({ resendId: data.id, status: msg.scheduledAt ? "scheduled" : "sent" })
    .where(eq(emails.id, emailId));
  log("email.queued", { emailId, scheduled: !!msg.scheduledAt });
  return { ok: true, emailId, resendId: data.id, scheduledAt: msg.scheduledAt };
}

export type CancelResult = { ok: true; cancelled: number } | { ok: false; reason: "already_sent" | "resend_error"; detail?: string };

/** Undo (PRD Step 11): cancel every still-scheduled email of this decision. */
export async function cancelDecisionEmails(decisionId: string, deps: Deps): Promise<CancelResult> {
  const { db } = deps;
  const resend = deps.resend ?? resendClient();
  const pending = await db.select().from(emails).where(and(eq(emails.decisionId, decisionId), inArray(emails.status, ["pending", "scheduled", "failed"])));
  let cancelled = 0;
  for (const e of pending) {
    if (!e.resendId) {
      await db.update(emails).set({ status: "cancelled" }).where(eq(emails.id, e.id));
      cancelled++;
      continue;
    }
    const { error } = await resend.emails.cancel(e.resendId);
    if (!error) {
      await db.update(emails).set({ status: "cancelled" }).where(eq(emails.id, e.id));
      cancelled++;
      continue;
    }
    // Undo race: the cancel failed. If it already went out, record that and stop.
    const { data } = await resend.emails.get(e.resendId);
    if (data && ["sent", "delivered", "opened", "clicked", "bounced", "complained", "delivery_delayed"].includes(data.last_event)) {
      await db.update(emails).set({ status: data.last_event === "bounced" ? "bounced" : "sent" }).where(eq(emails.id, e.id));
      return { ok: false, reason: "already_sent" };
    }
    if (data?.last_event === "canceled" || data?.last_event === "failed") {
      // Nothing will be sent, so Undo can go ahead.
      await db.update(emails).set({ status: data.last_event === "failed" ? "failed" : "cancelled" }).where(eq(emails.id, e.id));
      cancelled++;
      continue;
    }
    return { ok: false, reason: "resend_error", detail: error.message };
  }
  return { ok: true, cancelled };
}

/**
 * Backstop for missed webhooks: ask Resend what happened to emails whose send time has
 * passed but that we still think are scheduled. Statuses only move forward.
 */
export async function syncPastDueEmails(deps: Deps & { limit?: number }): Promise<number> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const resend = deps.resend ?? resendClient();
  const due = await db.select().from(emails).where(eq(emails.status, "scheduled"));
  const past = due.filter((e) => e.resendId && e.scheduledAt && e.scheduledAt.getTime() < now.getTime() - 5 * 60_000).slice(0, deps.limit ?? 50);
  const MAP: Record<string, "sent" | "delivered" | "bounced" | "failed" | "cancelled"> = {
    sent: "sent",
    delivered: "delivered",
    opened: "delivered",
    clicked: "delivered",
    delivery_delayed: "sent",
    bounced: "bounced",
    complained: "delivered",
    failed: "failed",
    suppressed: "failed",
    canceled: "cancelled",
  };
  let updated = 0;
  for (const e of past) {
    const { data } = await resend.emails.get(e.resendId!);
    const next = data ? MAP[data.last_event] : undefined;
    if (!next) continue;
    await db.update(emails).set({ status: next }).where(and(eq(emails.id, e.id), eq(emails.status, "scheduled")));
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
