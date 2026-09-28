import type { DimensionRun, ScorerRun, ScoredDim } from "@/lib/gemini/scorer";
import { SCORED_DIMS } from "@/lib/gemini/scorer";
import { normalizeText } from "@/lib/redact/normalize";

// Per-run evidence checks (PRD Step 7), applied to each Scorer run before runs are combined:
// 1. quote check: every quote must be an exact substring of the redacted profile, or the
//    dimension becomes 0 / low / QUOTE_MISMATCH (rubric §3 step 6). A score of 2+ with no
//    quote at all is treated the same way ("every score traces to a verbatim quote").
// 2. absent evidence → score at most 1, confidence low (rubric §5).
// 3. section cap: evidence only from [SUMMARY], [SKILLS] or [EDUCATION] caps the score at 1.

const CAPPED_SECTIONS = new Set(["SUMMARY", "SKILLS", "EDUCATION"]);

export type ProfileIndex = {
  normalized: string;
  sections: { name: string; norm: string }[];
  bullets: { id: string; norm: string }[];
};

export function indexProfile(text: string): ProfileIndex {
  const sections: { name: string; lines: string[] }[] = [];
  const bullets: { id: string; norm: string }[] = [];
  for (const line of text.split("\n")) {
    const header = /^\[(SUMMARY|SKILLS|EDUCATION|ROLE (\d+))[^\]]*\]$/.exec(line.trim());
    if (header) {
      sections.push({ name: header[2] ? "ROLE" : header[1], lines: [] });
      continue;
    }
    const current = sections.at(-1);
    if (!current) continue;
    current.lines.push(line);
    if (line.startsWith("- ")) bullets.push({ id: `b${bullets.length + 1}`, norm: normalizeText(line.slice(2)) });
  }
  return {
    normalized: normalizeText(text),
    sections: sections.map((s) => ({ name: s.name, norm: normalizeText(s.lines.join("\n")) })),
    bullets,
  };
}

export function quoteFound(index: ProfileIndex, quote: string): boolean {
  const q = normalizeText(quote);
  return q.length >= 3 && index.normalized.includes(q);
}

/** Bullets that contain the quote (used for the reuse limit). */
export function bulletsFor(index: ProfileIndex, quote: string): string[] {
  const q = normalizeText(quote);
  return index.bullets.filter((b) => b.norm.includes(q)).map((b) => b.id);
}

function onlyInCappedSections(index: ProfileIndex, quotes: string[]): boolean {
  return quotes.every((quote) => {
    const q = normalizeText(quote);
    const homes = index.sections.filter((s) => s.norm.includes(q));
    return homes.length > 0 && homes.every((s) => CAPPED_SECTIONS.has(s.name));
  });
}

export type CheckedDim = DimensionRun & { quoteFailed: boolean; capped: boolean };
export type CheckedRun = {
  dims: Record<ScoredDim, CheckedDim>;
  quals: ScorerRun["d7_qualifiers"];
  roleTypes: ScorerRun["role_types"];
};

export function checkDimension(d: DimensionRun, index: ProfileIndex): CheckedDim {
  const quotes = d.evidence.map((e) => e.quote);
  const badQuote = quotes.some((q) => !quoteFound(index, q));
  const unsupported = d.score >= 2 && quotes.length === 0;
  if (badQuote || unsupported) {
    return { ...d, score: 0, confidence: "low", quoteFailed: true, capped: false };
  }
  let out: CheckedDim = { ...d, quoteFailed: false, capped: false };
  if (out.evidence_status === "absent") out = { ...out, score: Math.min(out.score, 1), confidence: "low" };
  if (out.score > 1 && quotes.length && onlyInCappedSections(index, quotes)) out = { ...out, score: 1, capped: true };
  return out;
}

export function checkRun(run: ScorerRun, index: ProfileIndex): CheckedRun {
  const dims = Object.fromEntries(SCORED_DIMS.map((k) => [k, checkDimension(run.dimensions[k], index)])) as Record<
    ScoredDim,
    CheckedDim
  >;
  return { dims, quals: run.d7_qualifiers, roleTypes: run.role_types };
}
