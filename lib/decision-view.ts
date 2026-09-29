import { and, desc, eq, isNull } from "drizzle-orm";
import type { DecisionPanelProps } from "@/components/decision-panel";
import type { PoolConfig } from "./config/defaults";
import type { Db } from "./db/client";
import { candidates, decisions, emails, evaluations, pools } from "./db/schema";
import { STATUS_MOVES, type PipelineStatus } from "./decisions";
import { firstName, formatDate, renderAdvance, renderDecline, renderHold } from "./email/templates";

// Everything the decision panel needs, with previews rendered from the real templates.
const DATE_SENTINEL = "2099-01-01";

export async function decisionPanelProps(
  db: Db,
  ev: typeof evaluations.$inferSelect,
  cand: typeof candidates.$inferSelect,
  linked: { roleApplied: string; pipelineStatus: string | null }[],
): Promise<DecisionPanelProps> {
  const [pool] = await db.select().from(pools).where(eq(pools.id, ev.poolId));
  const config = pool.configJson as PoolConfig;
  const [active] = await db
    .select()
    .from(decisions)
    .where(and(eq(decisions.evaluationId, ev.id), isNull(decisions.undoneAt)))
    .orderBy(desc(decisions.decidedAt))
    .limit(1);
  const mails = await db.select().from(emails).where(eq(emails.evaluationId, ev.id)).orderBy(desc(emails.createdAt));
  const activeMail = active ? mails.find((m) => m.decisionId === active.id && m.kind === active.action) : undefined;

  const bookingUrl = process.env.BOOKING_URL || "[booking link not set]";
  const previews = {} as DecisionPanelProps["previews"];
  for (const role of ["PM", "SPM"] as const) {
    const common = { firstName: firstName(cand.displayName), roleTitle: role, legacy: cand.legacy };
    const hold = renderHold({ ...common, holdUntil: DATE_SENTINEL });
    previews[role] = {
      advance: renderAdvance({ ...common, inviteLine: "{{INVITE}}", bookingUrl, askRelocation: cand.eligibilityRelocate === "unstated" }),
      decline: renderDecline(common),
      hold: { subject: hold.subject, text: hold.text.replace(formatDate(DATE_SENTINEL), "{{DATE}}") },
    };
  }

  const holdDefault = new Date(Date.now() + config.holdDefaultDays * 86_400_000).toISOString().slice(0, 10);
  const undoWindowEnds =
    active && !activeMail ? new Date(active.decidedAt.getTime() + config.sendDelayMinutes[active.action] * 60_000).toISOString() : null;
  const pipelineStatus = (ev.pipelineStatus ?? "scored") as PipelineStatus;

  return {
    evaluationId: ev.id,
    processing: ev.status !== "scored" && ev.status !== "needs_review",
    pipelineStatus,
    roleApplied: ev.roleApplied,
    bestFitRole: ev.bestFitRole,
    noContact: cand.noContact || !cand.email,
    draftInvite: (ev.briefJson as { invite_line?: string } | null)?.invite_line ?? "",
    holdDefault,
    previews,
    active: active
      ? {
          decisionId: active.id,
          action: active.action,
          emailStatus: activeMail?.status ?? null,
          scheduledAt: activeMail?.scheduledAt?.toISOString() ?? null,
          decidedAt: active.decidedAt.toISOString(),
        }
      : null,
    undoWindowEnds,
    linkedOpen: linked
      .filter((l) => !["declined", "withdrawn"].includes(l.pipelineStatus ?? ""))
      .map((l) => (l.roleApplied === "SPM" ? "Senior PM" : l.roleApplied === "PM" ? "PM" : "the other role")),
    statusMoves: STATUS_MOVES[pipelineStatus] ?? [],
    history: mails.map((m) => ({ kind: m.kind, status: m.status, at: (m.scheduledAt ?? m.createdAt).toISOString() })),
  };
}
