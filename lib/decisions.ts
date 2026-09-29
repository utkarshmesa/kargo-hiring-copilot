import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { audit } from "./audit";
import type { PoolConfig } from "./config/defaults";
import type { Db } from "./db/client";
import { candidates, decisions, emails, evaluations, pools } from "./db/schema";
import { cancelDecisionEmails, sendForDecision, type ResendLike } from "./email/send";

// PRD Step 10: the human gate. Arjun decides; the system records the decision (with the
// tier it recommended, so overrides can be found later) and schedules the matching email.

export type Action = "advance" | "decline" | "hold";
export type PipelineStatus = "scored" | "advanced" | "booked" | "interviewed" | "offer" | "declined" | "hold" | "withdrawn";

const STATUS_OF: Record<Action, PipelineStatus> = { advance: "advanced", decline: "declined", hold: "hold" };

// Allowed moves (anything else → 400).
const DECISION_FROM: Record<Action, PipelineStatus[]> = {
  advance: ["scored", "hold"],
  hold: ["scored", "hold"],
  decline: ["scored", "hold", "advanced", "booked", "interviewed"],
};
export const STATUS_MOVES: Partial<Record<PipelineStatus, PipelineStatus[]>> = {
  advanced: ["booked", "withdrawn"],
  booked: ["interviewed", "withdrawn"],
  interviewed: ["offer", "withdrawn"],
};

export class DecisionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Deps = { db: Db; resend?: ResendLike; now?: () => Date };

export type DecideInput = {
  evaluationId: string;
  action: Action;
  reason?: string | null;
  holdUntil?: string | null;
  inviteLineOverride?: string | null;
  roleTitle?: "PM" | "SPM" | null;
};

export async function decide(input: DecideInput, deps: Deps) {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const [row] = await db
    .select({ ev: evaluations, cand: candidates, pool: pools })
    .from(evaluations)
    .innerJoin(candidates, eq(candidates.id, evaluations.candidateId))
    .innerJoin(pools, eq(pools.id, evaluations.poolId))
    .where(eq(evaluations.id, input.evaluationId));
  if (!row) throw new DecisionError("evaluation not found", 404);
  const { ev, cand, pool } = row;
  const config = pool.configJson as PoolConfig;

  if (ev.status !== "scored" && ev.status !== "needs_review") throw new DecisionError("This CV has not finished processing.", 409);
  const from = ev.pipelineStatus ?? "scored";
  if (!DECISION_FROM[input.action].includes(from)) throw new DecisionError(`Cannot ${input.action} from "${from}".`, 400);

  // A still-scheduled email must be undone before a new decision (one email in flight).
  // Past its send time an email is out of our hands (sent, or failed): it no longer blocks.
  const inFlight = (
    await db
      .select({ scheduledAt: emails.scheduledAt })
      .from(emails)
      .where(and(eq(emails.evaluationId, ev.id), inArray(emails.status, ["pending", "scheduled"])))
  ).filter((m) => !m.scheduledAt || m.scheduledAt > now);
  if (inFlight.length) throw new DecisionError("An email for this candidate is still scheduled. Undo it first.", 409);

  let roleTitle: "PM" | "SPM";
  if (ev.roleApplied === "NOT_SURE") {
    if (!input.roleTitle) throw new DecisionError("Pick the role title for the email (PM or Senior PM).", 400);
    roleTitle = input.roleTitle;
  } else roleTitle = ev.roleApplied;

  let holdUntil: string | null = null;
  if (input.action === "hold") {
    holdUntil = input.holdUntil ?? new Date(now.getTime() + config.holdDefaultDays * 86_400_000).toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(holdUntil) || holdUntil <= now.toISOString().slice(0, 10)) {
      throw new DecisionError("The Hold date must be in the future.", 400);
    }
  }
  let inviteLine: string | null = null;
  if (input.action === "advance") {
    const drafted = (ev.briefJson as { invite_line?: string } | null)?.invite_line ?? "";
    inviteLine = (input.inviteLineOverride ?? drafted).replace(/\s+/g, " ").trim().slice(0, 300);
    if (!cand.noContact && !process.env.BOOKING_URL) throw new DecisionError("BOOKING_URL is not set, so the invite can't include a booking link.", 409);
  }

  // Status change + decision + pool lock in one transaction. The status update is a
  // check-and-set, so a double click (or two tabs) can only ever create one decision.
  const decision = await db.transaction(async (tx) => {
    const moved = await tx
      .update(evaluations)
      .set({ pipelineStatus: STATUS_OF[input.action], pipelineStatusAt: now, roleTitleFinal: roleTitle })
      .where(and(eq(evaluations.id, ev.id), ev.pipelineStatus ? eq(evaluations.pipelineStatus, from) : isNull(evaluations.pipelineStatus)))
      .returning({ id: evaluations.id });
    if (!moved.length) throw new DecisionError("This candidate was just updated. Refresh and try again.", 409);
    const [d] = await tx
      .insert(decisions)
      .values({
        evaluationId: ev.id,
        action: input.action,
        reason: input.reason?.trim().slice(0, 500) || null,
        holdUntil,
        inviteLineFinal: inviteLine,
        recommendedTier: ev.tier,
        prevPipelineStatus: from,
        decidedAt: now,
      })
      .returning();
    // The first decision locks the pool's config (rubric §3.1).
    await tx.update(pools).set({ lockedAt: now }).where(and(eq(pools.id, pool.id), isNull(pools.lockedAt)));
    return d;
  });
  await audit(db, `decision.${input.action}`, decision.id);

  if (cand.noContact) return { decision, email: { ok: false as const, reason: "no_contact" as const } };
  const email = await sendForDecision(decision.id, input.action, deps);
  if (!email.ok) {
    // No email could be scheduled: the decision is rolled back so nothing is half-done.
    await revert(db, decision.id, ev.id, STATUS_OF[input.action], from, now);
    throw new DecisionError(`The email could not be scheduled (${email.reason}${email.detail ? `: ${email.detail}` : ""}). Nothing was saved.`, 502);
  }
  return { decision, email };
}

async function revert(db: Db, decisionId: string, evaluationId: string, current: PipelineStatus, previous: PipelineStatus, now: Date) {
  await db.transaction(async (tx) => {
    await tx.update(decisions).set({ undoneAt: now }).where(eq(decisions.id, decisionId));
    await tx
      .update(evaluations)
      .set({ pipelineStatus: previous, pipelineStatusAt: now })
      .where(and(eq(evaluations.id, evaluationId), eq(evaluations.pipelineStatus, current)));
  });
}

export type UndoResult = { ok: true } | { ok: false; reason: "already_sent" | "too_late" | "not_found" | "resend_error"; detail?: string };

// US6: Undo while the email is still scheduled. Cancels the Resend send, marks the decision
// undone and returns the candidate to the previous status, so Arjun can decide again.
export async function undo(decisionId: string, deps: Deps): Promise<UndoResult> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const [d] = await db.select().from(decisions).where(eq(decisions.id, decisionId));
  if (!d || d.undoneAt) return { ok: false, reason: "not_found" };
  const [latest] = await db.select().from(decisions).where(and(eq(decisions.evaluationId, d.evaluationId), isNull(decisions.undoneAt))).orderBy(desc(decisions.decidedAt)).limit(1);
  if (latest?.id !== d.id) return { ok: false, reason: "too_late", detail: "a later decision exists" };

  const mails = await db.select().from(emails).where(eq(emails.decisionId, d.id));
  if (mails.some((m) => ["sent", "delivered", "bounced"].includes(m.status))) return { ok: false, reason: "already_sent" };
  if (!mails.length) {
    // NO_CONTACT: no email; Undo is allowed within the same window the email would have had.
    const [ev] = await db.select({ poolId: evaluations.poolId }).from(evaluations).where(eq(evaluations.id, d.evaluationId));
    const [pool] = await db.select().from(pools).where(eq(pools.id, ev.poolId));
    const delay = (pool.configJson as PoolConfig).sendDelayMinutes[d.action];
    if (now.getTime() > d.decidedAt.getTime() + delay * 60_000) return { ok: false, reason: "too_late" };
  } else {
    if (!mails.some((m) => m.status === "scheduled" || m.status === "pending")) return { ok: false, reason: "too_late" };
    // Resend is the source of truth for the race at send time: cancel, or learn it went out.
    const cancelled = await cancelDecisionEmails(d.id, deps);
    if (!cancelled.ok) return cancelled;
  }
  await revert(db, d.id, d.evaluationId, STATUS_OF[d.action], d.prevPipelineStatus, now);
  await audit(db, "decision.undone", d.id);
  return { ok: true };
}

// Booked / Interviewed / Offer / Withdrawn (US7).
export async function setStatus(evaluationId: string, to: PipelineStatus, deps: Deps) {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const [ev] = await db.select().from(evaluations).where(eq(evaluations.id, evaluationId));
  if (!ev) throw new DecisionError("evaluation not found", 404);
  const from = ev.pipelineStatus ?? "scored";
  if (!STATUS_MOVES[from]?.includes(to)) throw new DecisionError(`Cannot move from "${from}" to "${to}".`, 400);
  const moved = await db
    .update(evaluations)
    .set({ pipelineStatus: to, pipelineStatusAt: now })
    .where(and(eq(evaluations.id, evaluationId), eq(evaluations.pipelineStatus, from)))
    .returning({ id: evaluations.id });
  if (!moved.length) throw new DecisionError("This candidate was just updated. Refresh and try again.", 409);
  await audit(db, `status.${to}`, evaluationId);
}
