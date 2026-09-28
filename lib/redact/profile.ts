import type { ExtractorOutput } from "@/lib/gemini/extractor";
import { formatDuration, roleSpan } from "./durations";
import { stripBulletGlyph } from "./normalize";
import {
  buildTerms,
  dropReason,
  emptyCounts,
  redactText,
  renderPlaceholders,
  splitSentences,
  stripLanguages,
  type RedactionCounts,
  type Terms,
} from "./redact";

// Step 5.4: the redacted_profile. A tagged plain-text document; its exact rendered text is
// stored as redacted_profile_text, quote checks run against it, and it is the only thing
// the Scorer and Writer ever receive.

export type ProfileRole = {
  index: number; // 1 = most recent
  sourceIndex: number; // position in extractor_json.roles (for experience maths in code)
  descriptor: string;
  title: string;
  months: number | null;
  duration: string;
  bullets: string[];
};

export type RedactedProfileJson = {
  summary: string | null;
  skills: string[];
  roles: ProfileRole[];
  education: { degree: string | null; certifications: string[] }[];
};

export type RedactedProfile = {
  text: string;
  json: RedactedProfileJson;
  counts: RedactionCounts;
  terms: Terms;
};

export function buildRedactedProfile(ex: ExtractorOutput, asOf: Date): RedactedProfile {
  const terms = buildTerms(ex);
  const counts = emptyCounts();
  const clean = (s: string) => renderPlaceholders(redactText(s, terms, counts));

  // A unit (bullet, sentence) that mentions a gap or a protected detail is dropped whole.
  const keepUnit = (unit: string) => {
    const reason = dropReason(unit);
    if (reason === "gap") counts.gapUnits++;
    if (reason === "personal") counts.personalUnits++;
    if (reason === "language") counts.languages++;
    return reason === null;
  };

  const summarySentences = ex.summary_raw ? splitSentences(ex.summary_raw).filter(keepUnit).map(clean) : [];
  const summary = summarySentences.filter(Boolean).join(" ") || null;

  // Skills entries: languages are stripped per entry, so "Languages: Python, Hindi" keeps Python.
  const skills = ex.skills_raw
    .filter((s) => dropReason(s) === "language" || keepUnit(s))
    .map((s) => stripLanguages(s, counts))
    .filter((s): s is string => s !== null)
    .map(clean)
    .filter(Boolean);

  // Most recent first: latest end date, then latest start. Unparseable dates sort last.
  const spans = ex.roles.map((r, i) => ({ r, i, span: roleSpan(r.start_raw, r.end_raw, asOf) }));
  spans.sort((a, b) => {
    if (!a.span || !b.span) return a.span ? -1 : b.span ? 1 : a.i - b.i;
    return b.span.end - a.span.end || b.span.start - a.span.start || a.i - b.i;
  });

  const roles: ProfileRole[] = spans.map(({ r, i, span }, pos) => ({
    index: pos + 1,
    sourceIndex: i,
    descriptor: clean(r.company_descriptor) || "company",
    title: clean(r.title),
    months: span?.months ?? null,
    duration: formatDuration(span?.months ?? null),
    bullets: r.bullets.map(stripBulletGlyph).filter(keepUnit).map(clean).filter(Boolean),
  }));

  const education = ex.education.map((e) => ({
    degree: e.degree_field ? clean(e.degree_field) || null : null,
    certifications: e.certifications.filter(keepUnit).map(clean).filter(Boolean),
  }));

  const json: RedactedProfileJson = { summary, skills, roles, education };
  return { text: renderProfile(json), json, counts, terms };
}

export function renderProfile(p: RedactedProfileJson): string {
  const out: string[] = [];
  if (p.summary) out.push("[SUMMARY]", p.summary, "");
  if (p.skills.length) out.push("[SKILLS]", p.skills.join(" · "), "");
  for (const r of p.roles) {
    const recent = r.index === 1 ? " · most recent" : "";
    out.push(`[ROLE ${r.index}${recent}]`);
    out.push(`Role ${r.index}${r.index === 1 ? " (most recent)" : ""}: ${r.descriptor} · ${r.title} · ${r.duration}`);
    for (const b of r.bullets) out.push(`- ${b}`);
    out.push("");
  }
  const edu = p.education.filter((e) => e.degree || e.certifications.length);
  if (edu.length) {
    out.push("[EDUCATION]");
    for (const e of edu) {
      if (e.degree) out.push(`[DEGREE: ${e.degree}]`);
      for (const c of e.certifications) out.push(`Certification: ${c}`);
    }
    out.push("");
  }
  return out.join("\n").trim() + "\n";
}
