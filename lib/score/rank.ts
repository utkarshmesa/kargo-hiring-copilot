import type { PoolConfig } from "@/lib/config/defaults";
import type { ExtractorOutput } from "@/lib/gemini/extractor";
import type { ScorerRun, ScoredDim } from "@/lib/gemini/scorer";
import type { RedactedProfileJson } from "@/lib/redact/profile";
import { anchorTexts } from "@/lib/rubric";
import { applyReuseLimit, combineDims, voteQualifiers, voteRoleTypes, type FinalDim, type Qualifiers } from "./combine";
import { checkRun, indexProfile } from "./evidence";
import { computeExperience, d7Score, type Experience } from "./experience";

// Step 7: rank, in code only. Pure and deterministic: stored raw runs + config → the same
// totals, tier and flags every time, so a config change never re-calls Gemini.

export type Role = "PM" | "SPM";
export type Tier = "A" | "B" | "C" | "D" | "R";
export type RoleApplied = Role | "NOT_SURE";

const PM_COUNTED: ScoredDim[] = ["D1", "D2", "D3", "D4", "D5", "D6"];
const SPM_COUNTED: ScoredDim[] = [...PM_COUNTED, "D8", "D9"];
export const countedDims = (role: Role) => (role === "PM" ? PM_COUNTED : SPM_COUNTED);

export type RankInput = {
  runs: ScorerRun[];
  profileText: string;
  profileJson: RedactedProfileJson;
  extractor: ExtractorOutput;
  asOf: Date;
  roleApplied: RoleApplied;
  config: PoolConfig;
};

export type RankResult = {
  dims: Record<ScoredDim, FinalDim>;
  d7: { PM: number; SPM: number };
  qualifiers: Qualifiers;
  experience: Experience;
  pmTotal: number;
  spmTotal: number;
  coreScore: number;
  roleUsed: Role;
  bestFitRole: Role;
  tier: Tier;
  tierReason: string | null;
  flags: string[];
};

type Scores = Partial<Record<ScoredDim | "D7", number>>;

export function weightedTotal(scores: Scores, weights: Partial<Record<string, number>>): number {
  return Object.entries(weights).reduce((sum, [dim, w]) => sum + ((scores[dim as ScoredDim] ?? 0) / 4) * (w ?? 0), 0);
}

export function rank(input: RankInput): RankResult {
  const { config } = input;
  const index = indexProfile(input.profileText);
  const checked = input.runs.map((r) => checkRun(r, index));
  const roleUsedGuess: Role = input.roleApplied === "SPM" ? "SPM" : "PM";
  const combined = combineDims(checked);
  const dims = applyReuseLimit(combined, index, config.weights[roleUsedGuess]);

  const types = voteRoleTypes(checked, input.profileJson.roles.length, index);
  const qualifiers = voteQualifiers(checked, index);
  const experience = computeExperience(input.profileJson.roles, input.extractor, types, input.asOf);
  const years = experience.pmRelevantYears;
  const d7 = { PM: d7Score("PM", years, qualifiers), SPM: d7Score("SPM", years, qualifiers) };

  const scores: Scores = Object.fromEntries(Object.values(dims).map((d) => [d.id, d.score]));
  const pmTotal = weightedTotal({ ...scores, D7: d7.PM }, config.weights.PM);
  const spmTotal = weightedTotal({ ...scores, D7: d7.SPM }, config.weights.SPM);
  const coreScore = weightedTotal(scores, config.weights.CORE);

  const bestFitRole: Role = spmTotal > pmTotal ? "SPM" : "PM";
  const roleUsed: Role = input.roleApplied === "NOT_SURE" ? bestFitRole : input.roleApplied;
  const total = roleUsed === "PM" ? pmTotal : spmTotal;
  const counted = countedDims(roleUsed).map((id) => dims[id]);

  // ---- flags (rubric §9). Only tier R changes the tier. ----
  const flags = new Set<string>();
  const s = (id: ScoredDim) => dims[id].score;
  if (s("D1") <= 2 && s("D2") >= 3 && s("D3") >= 3 && s("D4") >= 3) flags.add("WILDCARD");
  if (counted.some((d) => d.score === 4)) flags.add("VERIFY_CLAIM");
  const mismatches = counted.filter((d) => d.quoteMismatch).length;
  if (mismatches) flags.add("QUOTE_MISMATCH");
  const unstable = counted.some((d) => d.spread >= config.unstableSpread);
  if (unstable) flags.add("UNSTABLE_SCORE");
  if (copiesAnchorText(input.profileJson)) flags.add("INTEGRITY_CHECK");

  const floor = roleUsed === "PM" ? config.pmExperienceFloorYears : config.spmExperienceFloorYears;
  const belowFloor = floor > 0 && years < floor;
  if (belowFloor) flags.add("BELOW_EXPERIENCE_BAND");
  if (input.roleApplied === "PM" && years > 5 && s("D3") >= 3) flags.add("CONSIDER_SPM");
  if (input.roleApplied === "SPM" && years < 4) flags.add("CONSIDER_PM");
  if (input.roleApplied === "SPM" && years > 10) flags.add("LEVEL_CHECK");

  // ---- tier (rubric §8). Totals compared unrounded; bands half-open. ----
  const rReasons: string[] = [];
  if (experience.unparseableDates) rReasons.push("unparseable_dates");
  if (unstable) rReasons.push("unstable_score");
  if (mismatches >= 3) rReasons.push("quote_mismatch");
  if (counted.filter((d) => d.evidence_status === "absent").length >= 3) rReasons.push("absent_evidence");

  let tier: Tier;
  const reasons: string[] = [];
  if (rReasons.length) {
    tier = "R";
    reasons.push(...rReasons);
  } else if (total < config.tiers.C) {
    const evidenced = counted.filter(
      (d) => (d.evidence_status === "present" || d.evidence_status === "weak") && d.confidence !== "low",
    ).length;
    if (evidenced >= 4) tier = "D";
    else {
      tier = "R";
      reasons.push("insufficient_evidence");
    }
  } else if (total >= config.tiers.A) tier = "A";
  else if (total >= config.tiers.B) tier = "B";
  else tier = "C";

  // Caps: each only ever lowers A to B.
  if (tier === "A") {
    const caps: string[] = [];
    if (belowFloor) caps.push(roleUsed === "PM" ? "capped_pm_experience_floor" : "capped_spm_experience_floor");
    if (config.experienceBandStrict && d7[roleUsed] <= 2) caps.push("capped_experience_band");
    if (config.d1GateForTierA && s("D1") < 2) caps.push("capped_d1_gate");
    if (caps.length) {
      tier = "B";
      reasons.push(...caps);
    }
  }

  return {
    dims,
    d7,
    qualifiers,
    experience,
    pmTotal,
    spmTotal,
    coreScore,
    roleUsed,
    bestFitRole,
    tier,
    tierReason: reasons.length ? reasons.join(", ") : null,
    flags: [...flags],
  };
}

// INTEGRITY_CHECK for anchor copying (PRD Step 7): any 8-word sequence shared between a
// bullet and the rubric's anchor text.
const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
function shingles(s: string, n = 8): Set<string> {
  const w = words(s);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}
let anchorShingles: Set<string> | null = null;
export function copiesAnchorText(profile: RedactedProfileJson): boolean {
  anchorShingles ??= new Set(anchorTexts().flatMap((a) => [...shingles(a)]));
  return profile.roles.some((r) => r.bullets.some((b) => [...shingles(b)].some((s) => anchorShingles!.has(s))));
}
