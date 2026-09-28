import { describe, expect, it } from "vitest";
import { defaultConfig } from "@/lib/config/defaults";
import type { ScorerRun } from "@/lib/gemini/scorer";
import { buildRedactedProfile } from "@/lib/redact/profile";
import { median, voteRoleTypes } from "@/lib/score/combine";
import { checkDimension, checkRun, indexProfile } from "@/lib/score/evidence";
import { d7Score } from "@/lib/score/experience";
import { rank, weightedTotal } from "@/lib/score/rank";
import { AS_OF, B_CASES, mockRun, type BCase } from "../fixtures/bcases";

const base = B_CASES.find((c) => c.id === "B6")!; // strong ops PM, Tier A, 80
const profile = buildRedactedProfile(base.extractor, AS_OF);
const index = indexProfile(profile.text);
const good = mockRun(base, profile.json);

function rankWith(runs: ScorerRun[], overrides: Partial<Parameters<typeof rank>[0]> = {}) {
  return rank({
    runs,
    profileText: profile.text,
    profileJson: profile.json,
    extractor: base.extractor,
    asOf: AS_OF,
    roleApplied: "PM",
    config: defaultConfig,
    ...overrides,
  });
}
const clone = (r: ScorerRun): ScorerRun => structuredClone(r);

describe("weights and totals (rubric §7)", () => {
  it("contribution = score / 4 × weight", () => {
    expect(weightedTotal({ D1: 4, D2: 2 }, { D1: 20, D2: 15 })).toBe(27.5);
  });

  it("matches the Appendix A reference core scores", () => {
    const core = (s: number[]) => weightedTotal({ D1: s[0], D2: s[1], D3: s[2], D4: s[3], D5: s[4], D6: s[5] }, defaultConfig.weights.CORE);
    expect(core([4, 4, 4, 4, 3, 3])).toBe(95); // Lavanya
    expect(core([4, 4, 3, 2, 3, 4])).toBeCloseTo(86.25); // Meghna (86.2)
    expect(core([4, 3, 4, 2, 3, 4])).toBe(85); // Sunita
    expect(core([4, 4, 3, 2, 3, 3])).toBeCloseTo(83.75); // Rohan (83.8)
    expect(core([4, 3, 3, 3, 3, 2])).toBe(80); // Aditya
    expect(core([2, 2, 2, 2, 1, 3])).toBe(50); // Preetham
    expect(core([0, 2, 4, 2, 1, 0])).toBe(35); // Rahul
    expect(core([0, 2, 2, 2, 3, 0])).toBe(32.5); // Vikram
  });

  it("PM head-to-head on full PM weights: Lavanya 95 vs Vikram 45", () => {
    const pm = (s: number[]) =>
      weightedTotal({ D1: s[0], D2: s[1], D3: s[2], D4: s[3], D5: s[4], D6: s[5], D7: s[6] }, defaultConfig.weights.PM);
    expect(pm([4, 4, 4, 4, 3, 3, 4])).toBe(95);
    expect(pm([0, 2, 2, 2, 3, 0, 3])).toBe(45);
  });
});

describe("median and runs (PRD Step 7)", () => {
  it("takes the median per dimension", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 4, 3])).toBe(4);
  });

  it("takes evidence from the lowest-index run with the median score", () => {
    const a = clone(good);
    const b = clone(good);
    const c = clone(good);
    a.dimensions.D2.score = 4;
    a.dimensions.D2.rationale = "run 0";
    b.dimensions.D2.rationale = "run 1";
    c.dimensions.D2.rationale = "run 2";
    const r = rankWith([a, b, c]);
    expect(r.dims.D2.score).toBe(3);
    expect(r.dims.D2.rationale).toBe("run 1");
    expect(r.dims.D2.runScores).toEqual([4, 3, 3]);
  });

  it("a spread of 2 or more → UNSTABLE_SCORE → tier R", () => {
    const a = clone(good);
    a.dimensions.D4.score = 1;
    const b = clone(good);
    const r = rankWith([a, b, clone(good)]);
    expect(r.dims.D4.spread).toBe(2);
    expect(r.flags).toContain("UNSTABLE_SCORE");
    expect(r.tier).toBe("R");
  });
});

describe("quote checks", () => {
  it("a quote not in the profile → score 0, confidence low, QUOTE_MISMATCH", () => {
    const d = checkDimension({ ...good.dimensions.D2, evidence: [{ quote: "Invented achievement at a famous company", primary: true }] }, index);
    expect(d).toMatchObject({ score: 0, confidence: "low", quoteFailed: true });
    const run = clone(good);
    run.dimensions.D2.evidence = [{ quote: "Invented achievement", primary: true }];
    const r = rankWith([run, run, run]);
    expect(r.dims.D2.score).toBe(0);
    expect(r.flags).toContain("QUOTE_MISMATCH");
  });

  it("one bad quote among good ones still fails the dimension", () => {
    const d = checkDimension({ ...good.dimensions.D3, evidence: [...good.dimensions.D3.evidence, { quote: "not in the CV at all", primary: false }] }, index);
    expect(d.quoteFailed).toBe(true);
  });

  it("a score of 2+ with no quote is a mismatch", () => {
    expect(checkDimension({ ...good.dimensions.D3, evidence: [] }, index).quoteFailed).toBe(true);
  });

  it("quote check tolerates whitespace, dash and quote-mark differences only", () => {
    const q = good.dimensions.D4.evidence[0].quote.replace(/ /g, "  ").replace(/-/g, "–");
    expect(checkDimension({ ...good.dimensions.D4, evidence: [{ quote: q, primary: true }] }, index).quoteFailed).toBe(false);
    const changed = good.dimensions.D4.evidence[0].quote.replace("reversed", "undid");
    expect(checkDimension({ ...good.dimensions.D4, evidence: [{ quote: changed, primary: true }] }, index).quoteFailed).toBe(true);
  });

  it("3 or more mismatches → tier R", () => {
    const run = clone(good);
    for (const id of ["D2", "D3", "D4"] as const) run.dimensions[id].evidence = [{ quote: "fabricated", primary: true }];
    const r = rankWith([run, run, run]);
    expect(r.tier).toBe("R");
    expect(r.tierReason).toContain("quote_mismatch");
  });
});

describe("global evidence rules (rubric §5)", () => {
  it("evidence only in [SUMMARY] or [SKILLS] caps the score at 1", () => {
    const d = checkDimension(
      { score: 3, evidence_status: "present", confidence: "high", rationale: "", evidence: [{ quote: profile.json.summary!.slice(0, 40), primary: true }] },
      index,
    );
    expect(d).toMatchObject({ score: 1, capped: true });
  });

  it("absent evidence → at most 1, confidence low", () => {
    const d = checkDimension({ score: 1, evidence_status: "absent", confidence: "high", rationale: "", evidence: [] }, index);
    expect(d).toMatchObject({ score: 1, confidence: "low" });
  });

  it("a bullet may support at most 2 dimensions; extra uses drop to low confidence, score kept", () => {
    const run = clone(good);
    const bullet = run.dimensions.D6.evidence[0].quote; // used only by D6 in the fixture
    run.dimensions.D3.evidence = [{ quote: bullet, primary: false }];
    run.dimensions.D5.evidence = [{ quote: bullet, primary: false }];
    const r = rankWith([run, run, run]);
    // D6 keeps it (primary); D3 and D5 tie on score and weight, so dimension order keeps D3.
    expect(r.dims.D6.reuseNote).toBeUndefined();
    expect(r.dims.D3.reuseNote).toBeUndefined();
    expect(r.dims.D5.reuseNote).toMatch(/at most 2 dimensions/);
    expect(r.dims.D5.confidence).toBe("low");
    expect(r.dims.D5.score).toBe(3);
  });
});

describe("D7 bands (half-open, PRD Step 7)", () => {
  const q = (b = false, e = false, s = false) => ({ builtFromZero: b, earlyStage: e, seniorPmLayerAbove: s });
  it.each([
    [0, 0], [0.25, 1], [1.25, 1], [1.5, 2], [1.75, 2], [2, 3], [3.75, 3], [4, 2], [5.75, 2], [6, 1], [9, 1],
  ])("PM %s years → %s (not built from zero)", (years, want) => {
    expect(d7Score("PM", years, q())).toBe(want);
  });
  it("PM 2–4 years built from zero → 4", () => expect(d7Score("PM", 3, q(true))).toBe(4));
  it.each([
    [0, 0], [3.75, 1], [4, 2], [4.75, 2], [5, 3], [7.75, 3], [8, 2], [9.75, 2], [10, 1],
  ])("SPM %s years → %s", (years, want) => {
    expect(d7Score("SPM", years, q())).toBe(want);
  });
  it("SPM 5–8 years: 4 needs no senior-PM layer above AND early-stage exposure", () => {
    expect(d7Score("SPM", 6, q(false, true, false))).toBe(4);
    expect(d7Score("SPM", 6, q(false, true, true))).toBe(3);
    expect(d7Score("SPM", 6, q(false, false, false))).toBe(3);
  });
});

describe("experience (rubric §6)", () => {
  function withRoles(types: Record<number, "PM" | "PRODUCT_OWNING" | "OTHER">, roles: [string, string][]) {
    const c: BCase = structuredClone(base);
    c.extractor.roles = roles.map(([s, e], i) => ({ ...base.extractor.roles[0], title: `Role ${i}`, start_raw: s, end_raw: e, bullets: [`Did work number ${i} for operations users`] }));
    c.mock.roleTypes = types;
    const p = buildRedactedProfile(c.extractor, AS_OF);
    const allAbsent = Object.fromEntries(Object.keys(c.mock.dims).map((k) => [k, [0, "absent", "low", []]])) as unknown as BCase["mock"]["dims"];
    const run = mockRun({ ...c, mock: { ...c.mock, dims: allAbsent } }, p.json);
    return rank({ runs: [run, run, run], profileText: p.text, profileJson: p.json, extractor: c.extractor, asOf: AS_OF, roleApplied: "PM", config: defaultConfig }).experience;
  }

  it("counts overlapping months once, at the highest rate", () => {
    // PM Jan 2020–Dec 2021 (24m) overlapping PRODUCT_OWNING Jan 2021–Dec 2022 (24m, 12 of them overlap)
    const e = withRoles({ 1: "PRODUCT_OWNING", 2: "PM" }, [["Jan 2021", "Dec 2022"], ["Jan 2020", "Dec 2021"]]);
    expect(e.pmRelevantYears).toBe(2.5); // 24 PM months + 12 × 0.5
  });

  it("rounds to 0.25 years", () => {
    expect(withRoles({ 1: "PM" }, [["Jan 2024", "Jul 2024"]]).pmRelevantYears).toBe(0.5); // 7 months = 0.583
  });

  it("OTHER and INTERNSHIP count 0%", () => {
    expect(withRoles({ 1: "OTHER" }, [["Jan 2015", "Dec 2024"]]).pmRelevantYears).toBe(0);
  });

  it("a counted role with unreadable dates → unparseable_dates", () => {
    expect(withRoles({ 1: "PM" }, [["sometime", "later"]]).unparseableDates).toBe(true);
  });
});

describe("role type votes", () => {
  it("3-way tie → OTHER; PRODUCT_OWNING without a passing quote → OTHER", () => {
    const runs = [clone(good), clone(good), clone(good)].map((r, i) => {
      r.role_types = [{ role_index: 1, type: (["PM", "PRODUCT_OWNING", "INTERNSHIP"] as const)[i], quote: profile.json.roles[0].bullets[0] }];
      return r;
    });
    const checked = runs.map((r) => checkRun(r, index));
    expect(voteRoleTypes(checked, 1, index)[0].type).toBe("OTHER");
    for (const r of runs) r.role_types = [{ role_index: 1, type: "PRODUCT_OWNING", quote: "not in the profile" }];
    expect(voteRoleTypes(runs.map((r) => checkRun(r, index)), 1, index)[0].type).toBe("OTHER");
  });
});

describe("routing and caps", () => {
  it("'Not sure' ranks by the higher total", () => {
    const r = rankWith([good, good, good], { roleApplied: "NOT_SURE" });
    expect(r.roleUsed).toBe(r.pmTotal >= r.spmTotal ? "PM" : "SPM");
  });

  it("D1 gate (when on) caps Tier A at B when D1 < 2; the Wildcard list is unaffected", () => {
    const run = clone(good);
    run.dimensions.D1 = { score: 1, evidence_status: "weak", confidence: "medium", rationale: "", evidence: [{ quote: profile.json.roles[1].bullets[0], primary: true }] };
    run.dimensions.D5.score = 4;
    run.dimensions.D6.score = 4;
    run.dimensions.D2.score = 4;
    const off = rankWith([run, run, run]);
    const on = rankWith([run, run, run], { config: { ...defaultConfig, d1GateForTierA: true } });
    expect(off.tier).toBe("A");
    expect(on.tier).toBe("B");
    expect(on.tierReason).toContain("capped_d1_gate");
    expect(on.flags).toContain("WILDCARD");
  });

  it("strict experience band caps an out-of-band D7 (≤ 2) at B", () => {
    const run = clone(good);
    const r = rankWith([run, run, run], { config: { ...defaultConfig, experienceBandStrict: true }, asOf: new Date("2028-12-01T00:00:00Z") });
    expect(r.d7.PM).toBeLessThanOrEqual(2);
    expect(r.tier).not.toBe("A");
  });

  it("Tier D needs 4+ evidenced dimensions; otherwise a low total is Tier R", () => {
    const run = clone(good);
    for (const id of ["D1", "D2", "D3", "D4", "D5", "D6"] as const) {
      run.dimensions[id] = { score: 1, evidence_status: "weak", confidence: "low", rationale: "", evidence: [{ quote: profile.json.roles[0].bullets[0], primary: true }] };
    }
    const r = rankWith([run, run, run]);
    expect(r.tier).toBe("R");
    expect(r.tierReason).toContain("insufficient_evidence");
  });
});
