import { describe, expect, it } from "vitest";
import { defaultConfig } from "@/lib/config/defaults";
import { parseCv } from "@/lib/parse";
import { eligibility } from "@/lib/redact/identity";
import { checkLeaks } from "@/lib/redact/leak";
import { buildRedactedProfile } from "@/lib/redact/profile";
import { prepareProfile } from "@/lib/pipeline/prepare";
import { rank } from "@/lib/score/rank";
import { AS_OF, B_CASES, cvLines, mockRun, type BCase } from "../fixtures/bcases";
import { makeDocx } from "../fixtures/build";

// Rubric Appendix B regression cases with mocked Scorer output: deterministic, runs in CI.

function rankCase(c: BCase) {
  const profile = buildRedactedProfile(c.extractor, AS_OF);
  const run = mockRun(c, profile.json);
  return {
    profile,
    result: rank({
      runs: [run, run, run],
      profileText: profile.text,
      profileJson: profile.json,
      extractor: c.extractor,
      asOf: AS_OF,
      roleApplied: c.roleApplied,
      config: defaultConfig,
    }),
  };
}

export async function caseDocx(c: BCase) {
  const lines = cvLines(c.extractor);
  const hidden = (c.hiddenLines ?? []).map((text) => [{ text, color: "FFFFFF" }]);
  return makeDocx([...lines.slice(0, 3), ...hidden, ...lines.slice(3)]);
}

describe.each(B_CASES)("$id: $title", (c) => {
  const { profile, result } = rankCase(c);

  it(`lands in tier ${c.expect.tier}`, () => {
    expect(result.tier, `tier reason: ${result.tierReason}`).toBe(c.expect.tier);
  });

  if (c.expect.total !== undefined) {
    it(`totals ${c.expect.total}`, () => {
      const total = result.roleUsed === "PM" ? result.pmTotal : result.spmTotal;
      expect(total).toBeCloseTo(c.expect.total!, 5);
    });
  }

  it("has the expected flags", async () => {
    const flags = new Set(result.flags);
    if (c.hiddenLines) {
      const parsed = await parseCv(await caseDocx(c));
      if (parsed.integrityCheck) flags.add("INTEGRITY_CHECK");
      expect(parsed.text).not.toMatch(/ignore prior instructions/i);
    }
    for (const f of c.expect.flags ?? []) expect([...flags]).toContain(f);
    for (const f of c.expect.notFlags ?? []) expect([...flags]).not.toContain(f);
  });

  it("redacts the synthetic CV with zero leaks", () => {
    expect(checkLeaks(profile.text, profile.terms)).toEqual([]);
  });
});

describe("case-specific behaviour", () => {
  const byId = (id: string) => B_CASES.find((c) => c.id === id)!;

  it("B6: the career break is removed and never reaches the Scorer", () => {
    const { profile } = rankCase(byId("B6"));
    expect(profile.text).not.toMatch(/career break|care for family|Returned to work/i);
    expect(profile.text).not.toMatch(/\b20\d\d\b/);
  });

  it("B8: a thin CV is never recommended for decline", () => {
    const { result } = rankCase(byId("B8"));
    expect(result.tier).toBe("R");
    expect(result.tierReason).toContain("absent_evidence");
  });

  it("B9: the white-text injection is stripped and the score equals the clean CV's", async () => {
    const withInjection = rankCase(byId("B9")).result;
    const clean = rankCase({ ...byId("B9"), hiddenLines: undefined }).result;
    expect(withInjection.pmTotal).toBe(clean.pmTotal);
    const prepared = await prepareProfile({ bytes: await caseDocx(byId("B9")), asOf: AS_OF, extract: async () => byId("B9").extractor });
    expect(prepared.kind).toBe("ok");
    expect(prepared.parsed.hiddenText.join(" ")).toMatch(/ignore prior instructions/);
    if (prepared.kind === "ok") expect(prepared.profile.text).not.toMatch(/ignore|10\/10/i);
  });

  it("B12: 'not willing to relocate' is recorded, not scored", () => {
    const c = byId("B12");
    expect(eligibility(c.extractor)).toBe("stated_no");
    const { profile, result } = rankCase(c);
    expect(profile.text).not.toMatch(/relocate/i);
    expect(result.pmTotal).toBe(rankCase(byId("B10")).result.pmTotal);
  });

  it("B11: capped at B for SPM, and the PM total is also computed", () => {
    const { result } = rankCase(byId("B11"));
    expect(result.spmTotal).toBeGreaterThanOrEqual(70);
    expect(result.tierReason).toContain("capped_spm_experience_floor");
    expect(result.pmTotal).toBeGreaterThan(0);
  });

  it("every synthetic CV passes the fidelity check when rendered to DOCX", async () => {
    for (const c of B_CASES.filter((x) => x.id !== "B8")) {
      const r = await prepareProfile({ bytes: await caseDocx(c), asOf: AS_OF, extract: async () => c.extractor });
      expect(r.kind, c.id).toBe("ok");
    }
  });
});
