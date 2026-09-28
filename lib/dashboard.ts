import { desc, eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { candidates, emails, evaluations } from "./db/schema";
import type { Pool } from "./pools";

// Data for the Shortlist and Pipeline tabs (PRD Step 9). Arjun's own view: identity is
// shown here, never sent to a model.

export type Row = {
  id: string;
  candidateId: string;
  name: string;
  roleApplied: "PM" | "SPM" | "NOT_SURE";
  roleUsed: "PM" | "SPM" | null;
  status: "queued" | "processing" | "scored" | "needs_review" | "failed";
  tier: "A" | "B" | "C" | "D" | "R" | null;
  tierReason: string | null;
  pmTotal: number | null;
  spmTotal: number | null;
  coreScore: number | null;
  bestFitRole: "PM" | "SPM" | null;
  flags: string[];
  summary: string | null;
  pipelineStatus: string | null;
  pipelineStatusAt: Date | null;
  createdAt: Date;
  noContact: boolean;
  linkedCandidateIds: string[];
  lastEmail: { kind: string; status: string; at: Date } | null;
};

export async function poolRows(db: Db, pool: Pool): Promise<Row[]> {
  const rows = await db
    .select({ ev: evaluations, cand: candidates })
    .from(evaluations)
    .innerJoin(candidates, eq(candidates.id, evaluations.candidateId))
    .where(eq(evaluations.poolId, pool.id))
    .orderBy(desc(evaluations.createdAt));
  const mail = await db
    .select({ evaluationId: evaluations.id, kind: emails.kind, status: emails.status, at: emails.createdAt })
    .from(emails)
    .innerJoin(evaluations, eq(evaluations.id, emails.evaluationId))
    .where(eq(evaluations.poolId, pool.id))
    .orderBy(desc(emails.createdAt));
  const lastEmail = new Map<string, Row["lastEmail"]>();
  for (const m of mail) if (!lastEmail.has(m.evaluationId)) lastEmail.set(m.evaluationId, { kind: m.kind, status: m.status, at: m.at });

  return rows.map(({ ev, cand }) => ({
    id: ev.id,
    candidateId: cand.id,
    name: cand.displayName ?? cand.fileName ?? `CV ${ev.id.slice(0, 8)}`,
    roleApplied: ev.roleApplied,
    roleUsed: ((ev.dimsFinalJson as { roleUsed?: "PM" | "SPM" } | null)?.roleUsed ?? null),
    status: ev.status,
    tier: ev.tier,
    tierReason: ev.tierReason,
    pmTotal: ev.pmTotal,
    spmTotal: ev.spmTotal,
    coreScore: ev.coreScore,
    bestFitRole: ev.bestFitRole,
    flags: ev.flags,
    summary: (ev.briefJson as { why_ranked_here?: string } | null)?.why_ranked_here ?? null,
    pipelineStatus: ev.pipelineStatus,
    pipelineStatusAt: ev.pipelineStatusAt,
    createdAt: ev.createdAt,
    noContact: cand.noContact,
    linkedCandidateIds: cand.linkedCandidateIds,
    lastEmail: lastEmail.get(ev.id) ?? null,
  }));
}

/** The total the tier was computed on: the applied role, or the best fit when "Not sure". */
export function rankedTotal(r: Pick<Row, "roleUsed" | "roleApplied" | "pmTotal" | "spmTotal">): number {
  const role = r.roleUsed ?? (r.roleApplied === "SPM" ? "SPM" : "PM");
  return (role === "PM" ? r.pmTotal : r.spmTotal) ?? 0;
}

/** "Better fit for SPM/PM" when the other role's total is ≥ 10 points higher (PRD Step 7). */
export function betterFit(r: Pick<Row, "roleUsed" | "roleApplied" | "pmTotal" | "spmTotal">): "PM" | "SPM" | null {
  if (r.pmTotal === null || r.spmTotal === null) return null;
  const role = r.roleUsed ?? (r.roleApplied === "SPM" ? "SPM" : "PM");
  if (role === "PM" && r.spmTotal - r.pmTotal >= 10) return "SPM";
  if (role === "SPM" && r.pmTotal - r.spmTotal >= 10) return "PM";
  return null;
}

export type Sections = { A: Row[]; wildcards: Row[]; B: Row[]; C: Row[]; R: Row[]; D: Row[]; inProgress: Row[] };

// Shortlist order (PRD Step 9 / rubric §12): Tier A by total with the Wildcard list beside
// it, then B and C, then "Please read" (R), then D collapsed. Wildcards also stay in their
// own tier section; no gate or cap removes someone from the Wildcard list.
export function shortlistSections(rows: Row[]): Sections {
  const byTotal = (a: Row, b: Row) => rankedTotal(b) - rankedTotal(a) || a.createdAt.getTime() - b.createdAt.getTime();
  const done = rows.filter((r) => (r.status === "scored" || r.status === "needs_review") && r.tier);
  const tier = (t: string) => done.filter((r) => r.tier === t).sort(byTotal);
  return {
    A: tier("A"),
    wildcards: done.filter((r) => r.flags.includes("WILDCARD")).sort(byTotal),
    B: tier("B"),
    C: tier("C"),
    R: done.filter((r) => r.tier === "R").sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    D: tier("D"),
    inProgress: rows.filter((r) => r.status === "queued" || r.status === "processing" || r.status === "failed"),
  };
}

export function daysSince(d: Date | null, now = new Date()): number | null {
  if (!d) return null;
  return Math.floor((now.getTime() - d.getTime()) / 86_400_000);
}

export const PIPELINE_LABEL: Record<string, string> = {
  scored: "Awaiting decision",
  advanced: "Advanced",
  booked: "Booked",
  interviewed: "Interviewed",
  offer: "Offer",
  declined: "Declined",
  hold: "Hold",
  withdrawn: "Withdrawn",
};

export const ROLE_LABEL: Record<string, string> = { PM: "PM", SPM: "Senior PM", NOT_SURE: "Not sure" };
