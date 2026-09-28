import { describe, expect, it } from "vitest";
import { betterFit, daysSince, rankedTotal, shortlistSections, type Row } from "@/lib/dashboard";

let n = 0;
function row(p: Partial<Row>): Row {
  n++;
  return {
    id: `id-${n}`,
    candidateId: `c-${n}`,
    name: `Candidate ${n}`,
    roleApplied: "PM",
    roleUsed: "PM",
    status: "scored",
    tier: "B",
    tierReason: null,
    pmTotal: 60,
    spmTotal: 50,
    coreScore: 60,
    bestFitRole: "PM",
    flags: [],
    summary: null,
    pipelineStatus: "scored",
    pipelineStatusAt: new Date("2026-09-20"),
    createdAt: new Date(2026, 8, n),
    noContact: false,
    linkedCandidateIds: [],
    lastEmail: null,
    ...p,
  };
}

describe("shortlist sections (PRD Step 9)", () => {
  const a1 = row({ tier: "A", pmTotal: 72 });
  const a2 = row({ tier: "A", pmTotal: 88 });
  const wildB = row({ tier: "B", pmTotal: 66, flags: ["WILDCARD"] });
  const wildR = row({ tier: "R", status: "needs_review", flags: ["WILDCARD", "UNSTABLE_SCORE"] });
  const c = row({ tier: "C", pmTotal: 45 });
  const d = row({ tier: "D", pmTotal: 30 });
  const r = row({ tier: "R", status: "needs_review", tierReason: "unparseable", pmTotal: null });
  const queued = row({ status: "queued", tier: null });
  const failed = row({ status: "failed", tier: null });
  const s = shortlistSections([a1, a2, wildB, wildR, c, d, r, queued, failed]);

  it("sorts Tier A by total, highest first", () => {
    expect(s.A.map((x) => x.id)).toEqual([a2.id, a1.id]);
  });

  it("lists every Wildcard beside Tier A, whatever its tier, and keeps it in its own section", () => {
    expect(s.wildcards.map((x) => x.id).sort()).toEqual([wildB.id, wildR.id].sort());
    expect(s.B.map((x) => x.id)).toContain(wildB.id);
    expect(s.R.map((x) => x.id)).toContain(wildR.id);
  });

  it("puts thin/failed-to-score CVs in Please read, never in D", () => {
    expect(s.R.map((x) => x.id)).toContain(r.id);
    expect(s.D.map((x) => x.id)).toEqual([d.id]);
  });

  it("keeps unscored CVs out of the tiers", () => {
    expect(s.inProgress.map((x) => x.id).sort()).toEqual([queued.id, failed.id].sort());
    expect([...s.A, ...s.B, ...s.C, ...s.D, ...s.R].map((x) => x.id)).not.toContain(queued.id);
  });
});

describe("totals shown", () => {
  it("ranks on the applied role, or the best fit when Not sure", () => {
    expect(rankedTotal({ roleUsed: "SPM", roleApplied: "SPM", pmTotal: 80, spmTotal: 60 })).toBe(60);
    expect(rankedTotal({ roleUsed: "SPM", roleApplied: "NOT_SURE", pmTotal: 60, spmTotal: 70 })).toBe(70);
  });

  it("says 'better fit' only when the other role is ≥ 10 points higher", () => {
    expect(betterFit({ roleUsed: "PM", roleApplied: "PM", pmTotal: 60, spmTotal: 70 })).toBe("SPM");
    expect(betterFit({ roleUsed: "PM", roleApplied: "PM", pmTotal: 60, spmTotal: 69.9 })).toBeNull();
    expect(betterFit({ roleUsed: "SPM", roleApplied: "SPM", pmTotal: 75, spmTotal: 60 })).toBe("PM");
  });

  it("counts days in status", () => {
    expect(daysSince(new Date("2026-09-20T00:00:00Z"), new Date("2026-09-28T12:00:00Z"))).toBe(8);
    expect(daysSince(null)).toBeNull();
  });
});
