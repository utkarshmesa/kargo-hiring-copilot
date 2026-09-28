import type { ExtractorOutput } from "@/lib/gemini/extractor";
import { roleSpan } from "@/lib/redact/durations";
import type { ProfileRole } from "@/lib/redact/profile";
import type { Qualifiers, RoleType, VotedRoleType } from "./combine";

// Rubric §6: experience in code. PM counts 100%, PRODUCT_OWNING 50% (only with a quote),
// OTHER and INTERNSHIP 0%. Overlapping months count once at the highest rate. Rounded to
// 0.25 years. Months come from the raw (pre-redaction) dates; "Present" = the as-of date.

const RATE: Record<RoleType, number> = { PM: 1, PRODUCT_OWNING: 0.5, OTHER: 0, INTERNSHIP: 0 };

export type Experience = {
  pmRelevantYears: number;
  roles: { roleIndex: number; type: RoleType; months: number | null; rate: number; quote: string | null }[];
  /** A counted role (PM / PRODUCT_OWNING) whose dates could not be parsed. */
  unparseableDates: boolean;
};

export function computeExperience(
  profileRoles: ProfileRole[],
  extractor: ExtractorOutput,
  types: VotedRoleType[],
  asOf: Date,
): Experience {
  const monthRate = new Map<number, number>();
  let unparseableDates = false;
  const roles = profileRoles.map((pr) => {
    const voted = types.find((t) => t.roleIndex === pr.index) ?? { type: "OTHER" as RoleType, quote: null };
    const rate = RATE[voted.type];
    const raw = extractor.roles[pr.sourceIndex];
    const span = raw ? roleSpan(raw.start_raw, raw.end_raw, asOf) : null;
    if (rate > 0) {
      if (!span) unparseableDates = true;
      else for (let m = span.start; m <= span.end; m++) monthRate.set(m, Math.max(monthRate.get(m) ?? 0, rate));
    }
    return { roleIndex: pr.index, type: voted.type, months: span?.months ?? null, rate, quote: voted.quote };
  });
  const weightedMonths = [...monthRate.values()].reduce((a, b) => a + b, 0);
  const pmRelevantYears = Math.round((weightedMonths / 12) * 4) / 4;
  return { pmRelevantYears, roles, unparseableDates };
}

// Rubric §5 D7 with the PRD's half-open bands. 4 vs 3 comes from the qualifier booleans.
export function d7Score(role: "PM" | "SPM", years: number, q: Qualifiers): number {
  if (years <= 0) return 0;
  if (role === "PM") {
    if (years < 1.5) return 1;
    if (years < 2) return 2;
    if (years < 4) return q.builtFromZero ? 4 : 3;
    if (years < 6) return 2;
    return 1;
  }
  if (years < 4) return 1;
  if (years < 5) return 2;
  if (years < 8) return !q.seniorPmLayerAbove && q.earlyStage ? 4 : 3;
  if (years < 10) return 2;
  return 1;
}
