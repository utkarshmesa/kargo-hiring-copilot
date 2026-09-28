import { SCORED_DIMS, type ScoredDim } from "@/lib/gemini/scorer";
import type { CheckedDim, CheckedRun, ProfileIndex } from "./evidence";
import { bulletsFor, quoteFound } from "./evidence";

// Combining the runs (PRD Step 7). Median per dimension; evidence, status, confidence
// and rationale come from the lowest-index run whose score equals the median.
// role_types and D7 booleans are majority votes, falling back to OTHER / false on a tie
// or when the winning value has no quote that passes the check.

export type FinalDim = Omit<CheckedDim, "quoteFailed"> & {
  id: ScoredDim;
  runScores: number[];
  spread: number;
  quoteMismatch: boolean;
  reuseNote?: string;
};

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function combineDims(runs: CheckedRun[]): Record<ScoredDim, FinalDim> {
  const out = {} as Record<ScoredDim, FinalDim>;
  for (const id of SCORED_DIMS) {
    const scores = runs.map((r) => r.dims[id].score);
    const m = median(scores);
    const chosen = runs.find((r) => r.dims[id].score === m)!.dims[id];
    const { quoteFailed, ...rest } = chosen;
    out[id] = {
      ...rest,
      id,
      score: m,
      runScores: scores,
      spread: Math.max(...scores) - Math.min(...scores),
      quoteMismatch: quoteFailed,
    };
  }
  return out;
}

export type RoleType = "PM" | "PRODUCT_OWNING" | "OTHER" | "INTERNSHIP";
export type VotedRoleType = { roleIndex: number; type: RoleType; quote: string | null };

export function voteRoleTypes(runs: CheckedRun[], roleCount: number, index: ProfileIndex): VotedRoleType[] {
  const out: VotedRoleType[] = [];
  for (let roleIndex = 1; roleIndex <= roleCount; roleIndex++) {
    const votes = runs.map((r) => r.roleTypes.find((t) => t.role_index === roleIndex) ?? { role_index: roleIndex, type: "OTHER" as const, quote: null });
    const counts = new Map<RoleType, number>();
    for (const v of votes) counts.set(v.type, (counts.get(v.type) ?? 0) + 1);
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const tie = ranked.length > 1 && ranked[0][1] === ranked[1][1];
    let type: RoleType = tie ? "OTHER" : ranked[0][0];
    let quote: string | null = null;
    if (type === "PM" || type === "PRODUCT_OWNING") {
      quote = votes.find((v) => v.type === type && v.quote && quoteFound(index, v.quote))?.quote ?? null;
      if (!quote) type = "OTHER";
    }
    out.push({ roleIndex, type, quote });
  }
  return out;
}

export type Qualifiers = { builtFromZero: boolean; earlyStage: boolean; seniorPmLayerAbove: boolean };

export function voteQualifiers(runs: CheckedRun[], index: ProfileIndex): Qualifiers {
  const vote = (key: keyof CheckedRun["quals"]) => {
    const yes = runs.filter((r) => r.quals[key].value);
    if (yes.length * 2 <= runs.length) return false;
    return yes.some((r) => r.quals[key].quote && quoteFound(index, r.quals[key].quote!));
  };
  return {
    builtFromZero: vote("built_from_zero"),
    earlyStage: vote("early_stage_exposure"),
    seniorPmLayerAbove: vote("senior_pm_layer_above"),
  };
}

// Reuse limit (rubric §5): one bullet may support at most 2 dimensions. A bullet used by
// more keeps the 2 uses where it is primary, then highest-scoring, then highest-weight;
// the rest drop to confidence low with a note. Scores are unchanged (PRD Step 7).
export function applyReuseLimit(
  dims: Record<ScoredDim, FinalDim>,
  index: ProfileIndex,
  weights: Partial<Record<string, number>>,
): Record<ScoredDim, FinalDim> {
  const uses = new Map<string, { id: ScoredDim; primary: boolean }[]>();
  for (const id of SCORED_DIMS) {
    const seen = new Set<string>();
    for (const e of dims[id].evidence) {
      for (const b of bulletsFor(index, e.quote)) {
        if (seen.has(b)) continue;
        seen.add(b);
        uses.set(b, [...(uses.get(b) ?? []), { id, primary: e.primary }]);
      }
    }
  }
  const out = { ...dims };
  for (const [bullet, list] of uses) {
    if (list.length <= 2) continue;
    const order = [...list].sort(
      (a, b) =>
        Number(b.primary) - Number(a.primary) ||
        dims[b.id].score - dims[a.id].score ||
        (weights[b.id] ?? 0) - (weights[a.id] ?? 0) ||
        SCORED_DIMS.indexOf(a.id) - SCORED_DIMS.indexOf(b.id),
    );
    for (const drop of order.slice(2)) {
      out[drop.id] = {
        ...out[drop.id],
        confidence: "low",
        reuseNote: `Evidence bullet ${bullet} already supports ${order
          .slice(0, 2)
          .map((u) => u.id)
          .join(" and ")}; a bullet may support at most 2 dimensions.`,
      };
    }
  }
  return out;
}
