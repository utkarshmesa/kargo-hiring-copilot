import type { ExtractorOutput } from "@/lib/gemini/extractor";
import { normalizeBullet, normalizeText } from "./normalize";

// Step 5.1. Rubric §3: every extracted bullet must be an exact substring of the original
// text (100% of bullets). PRD: the extracted parts must also cover ≥ 60% of the visible
// characters, excluding identity lines, so a dropped section is caught too.
export const MIN_COVERAGE = 0.6;

export type FidelityResult = {
  ok: boolean;
  bulletsTotal: number;
  bulletsMissing: number;
  coverage: number;
};

export function checkFidelity(visibleText: string, ex: ExtractorOutput): FidelityResult {
  const haystack = normalizeText(visibleText);
  const bullets = ex.roles.flatMap((r) => r.bullets).map(normalizeBullet).filter(Boolean);
  const bulletsMissing = bullets.filter((b) => !haystack.includes(b)).length;

  const extractedChars = [
    ...ex.roles.flatMap((r) => [r.title, r.company_raw, r.start_raw ?? "", r.end_raw ?? "", ...r.bullets]),
    ex.summary_raw ?? "",
    ...ex.skills_raw,
  ]
    .map((s) => normalizeBullet(s).length)
    .reduce((a, b) => a + b, 0);

  const identity = [ex.identity.name, ...ex.identity.emails, ...ex.identity.phones, ...ex.identity.urls]
    .filter((s): s is string => !!s)
    .map((s) => s.toLowerCase());
  const nonIdentityChars = visibleText
    .split("\n")
    .filter((line) => !identity.some((id) => line.toLowerCase().includes(id)))
    .map((line) => normalizeText(line).length)
    .reduce((a, b) => a + b, 0);

  const coverage = nonIdentityChars === 0 ? 0 : Math.min(1, extractedChars / nonIdentityChars);
  return {
    ok: bullets.length > 0 && bulletsMissing === 0 && coverage >= MIN_COVERAGE,
    bulletsTotal: bullets.length,
    bulletsMissing,
    coverage: Math.round(coverage * 1000) / 1000,
  };
}
