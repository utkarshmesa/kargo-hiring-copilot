import type { ExtractorOutput } from "@/lib/gemini/extractor";
import { ACADEMIC_PATTERNS, GAP_PATTERNS, HUMAN_LANGUAGES, PERSONAL_PATTERNS, lists } from "./lists";

// Step 5.4: code redaction. Every identity string is replaced wherever it appears.
// Placeholders are held as private-use tokens while redacting so later passes can't
// match inside them, then rendered as [CANDIDATE], [COMPANY], … at the end.

export type Terms = {
  names: string[];
  emails: string[];
  phones: string[];
  urls: string[];
  locations: string[];
  institutions: string[];
  companies: string[];
};

export type RedactionCounts = Record<
  | "emails" | "urls" | "phones" | "names" | "companies" | "institutions" | "locations"
  | "honorifics" | "pronouns" | "dates" | "academic" | "gapUnits" | "personalUnits" | "languages",
  number
>;

export const emptyCounts = (): RedactionCounts => ({
  emails: 0, urls: 0, phones: 0, names: 0, companies: 0, institutions: 0, locations: 0,
  honorifics: 0, pronouns: 0, dates: 0, academic: 0, gapUnits: 0, personalUnits: 0, languages: 0,
});

const PH = {
  CANDIDATE: "C",
  COMPANY: "O",
  INSTITUTION: "I",
  LOCATION: "L",
  REFEREE: "R",
  DATE: "D",
} as const;
const PH_RENDER: Record<string, string> = {
  C: "[CANDIDATE]", O: "[COMPANY]", I: "[INSTITUTION]", L: "[LOCATION]", R: "[REFEREE]", D: "[DATE]",
};

// Words that describe a company rather than name it. The distinctive name is the run of
// words before the first of these: "Blue Anchor Freight Pvt. Ltd." → "Blue Anchor".
const GENERIC_COMPANY_WORDS = new Set(
  (
    "technologies technology tech solutions services service software systems labs lab consulting consultants " +
    "logistics freight forwarders forwarding forwarder shipping port ports terminal pvt private ltd limited llp inc " +
    "corp corporation company co group india international global hr fintech digital practice cha advisory brand " +
    "employer and & the of enterprises industries infotech infosystems ventures holdings partners analytics"
  ).split(" "),
);
const NOT_A_COMPANY = /^(self[- ]?employed|independent|freelance|freelancer|consultant|various|confidential)$/i;

export function companyTerms(raw: string): string[] {
  const cleaned = raw.replace(/\(.*?\)/g, " ").replace(/[,|].*$/, "").replace(/\s+/g, " ").trim();
  if (!cleaned || NOT_A_COMPANY.test(cleaned)) return [];
  const words = cleaned.split(" ");
  const lead: string[] = [];
  for (const w of words) {
    if (GENERIC_COMPANY_WORDS.has(w.toLowerCase().replace(/[.]/g, ""))) break;
    lead.push(w);
  }
  const out = new Set<string>();
  if (cleaned.length >= 3) out.add(cleaned);
  const leadName = lead.join(" ").replace(/[.,]+$/, "");
  if (leadName.length >= 3) out.add(leadName);
  return [...out];
}

export function namePartsOf(name: string | null): string[] {
  if (!name) return [];
  const full = name.replace(/\s+/g, " ").trim();
  const parts = full.split(/[\s.\-]+/).filter((p) => p.length >= 3);
  return [...new Set([full, ...parts])];
}

function splitPlaces(values: string[]): string[] {
  return values
    .flatMap((v) => v.split(/[,/|;·]| - /))
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
}

export function buildTerms(ex: ExtractorOutput): Terms {
  return {
    names: namePartsOf(ex.identity.name),
    emails: ex.identity.emails.filter(Boolean),
    phones: ex.identity.phones.filter(Boolean),
    urls: ex.identity.urls.filter(Boolean),
    locations: splitPlaces(ex.identity.locations),
    institutions: ex.education.map((e) => e.institution_raw).filter((s): s is string => !!s && s.length >= 3),
    companies: [...new Set(ex.roles.flatMap((r) => companyTerms(r.company_raw)))],
  };
}

// ---------- matching helpers ----------

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isAcronym = (s: string) => /^[A-Z]{2,6}s?$/.test(s);

/** Whole-word, whitespace-flexible matcher. Acronyms match case-sensitively. */
export function termRegex(term: string, forceCase?: boolean): RegExp {
  const body = term.trim().split(/\s+/).map(escape).join("\\s+");
  const flags = forceCase ?? isAcronym(term.trim()) ? "gu" : "giu";
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, flags);
}

const byLengthDesc = (a: string, b: string) => b.length - a.length;

function replaceTerms(text: string, terms: string[], placeholder: string, onHit: (n: number) => void): string {
  let out = text;
  for (const t of [...new Set(terms)].sort(byLengthDesc)) {
    out = out.replace(termRegex(t), () => {
      onHit(1);
      return placeholder;
    });
  }
  return out;
}

export const EMAIL_RE = /[\w.+%-]+@[\w-]+(\.[\w-]+)+/g;
export const URL_RE = /\b(https?:\/\/\S+|www\.\S+|(?:[\w-]+\.)+(?:com|in|io|me|org|net|dev|co|ai|app)\/\S*)/gi;
// 10+ digits with optional separators: phone numbers, never metrics like "₹4.2Cr" or "2M+".
export const PHONE_RE = /(?<![\w₹$€£])\+?\d[\d\s\-().]{8,}\d(?![\w%])/g;

const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)";
export const YEAR = "(?:19[5-9]\\d|20[0-3]\\d)";
// "2000+ employees", "1999 shipments" are counts, not years: company size matters for D3/D7.
export const NOT_A_COUNT =
  "(?![%\\d]|\\s*\\+|\\s+(?:employees|staff|people|members|engineers|clients|customers|users|merchants|shipments|containers|orders|accounts|units|stores|trucks|vehicles|SKUs|tickets)\\b)";
const DATE_PATTERNS: RegExp[] = [
  new RegExp(`\\b${MONTH}\\.?,?\\s*(?:${YEAR}|'\\d{2})\\b`, "g"),
  /\b\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})\b/g,
  new RegExp(`\\b${YEAR}[/-](?:0?[1-9]|1[0-2])\\b(?![/-]\\d)`, "g"),
  new RegExp(`\\b(?:0?[1-9]|1[0-2])/${YEAR}\\b`, "g"),
  /\bFY\s?'?\d{2}(?:\d{2})?(?:\s*[-–/]\s*'?\d{2,4})?\b/g,
  new RegExp(`(?<![₹$€£#\\d.,])\\b${YEAR}(?:\\s*[-–]\\s*\\d{2})?\\b${NOT_A_COUNT}`, "g"),
];

const PRONOUNS: [RegExp, string][] = [
  [/\b(he|she)'s\b/gi, "they're"],
  [/\b(himself|herself)\b/gi, "themself"],
  [/\bhers\b/gi, "theirs"],
  [/\b(he|she)\b/gi, "they"],
  // "her" before a word is almost always possessive in a CV ("her team" → "their team").
  [/\bher(?=\s+[\p{L}])/giu, "their"],
  [/\b(him|her)\b/gi, "them"],
  [/\bhis\b/gi, "their"],
];

function matchCase(original: string, replacement: string): string {
  if (original === original.toUpperCase() && original.length > 1) return replacement.toUpperCase();
  if (original[0] === original[0].toUpperCase()) return replacement[0].toUpperCase() + replacement.slice(1);
  return replacement;
}

// ---------- text pass ----------

export function redactText(input: string, terms: Terms, counts: RedactionCounts): string {
  const { cities, colleges } = lists();
  const hit = (k: keyof RedactionCounts) => (n: number) => (counts[k] += n);
  let s = input;

  s = s.replace(EMAIL_RE, () => (hit("emails")(1), PH.CANDIDATE));
  s = replaceTerms(s, terms.urls, PH.CANDIDATE, hit("urls"));
  s = s.replace(URL_RE, () => (hit("urls")(1), PH.CANDIDATE));
  s = replaceTerms(s, terms.phones, PH.CANDIDATE, hit("phones"));
  s = s.replace(PHONE_RE, (m) => (m.replace(/\D/g, "").length >= 10 ? (hit("phones")(1), PH.CANDIDATE) : m));
  s = replaceTerms(s, [...terms.institutions, ...colleges], PH.INSTITUTION, hit("institutions"));
  s = replaceTerms(s, terms.companies, PH.COMPANY, hit("companies"));
  s = replaceTerms(s, [...terms.locations, ...cities], PH.LOCATION, hit("locations"));
  s = replaceTerms(s, terms.names, PH.CANDIDATE, hit("names"));

  // Honorifics: before the candidate → dropped; before another name → [REFEREE]; bare → dropped.
  const HON = "\\b(?:Mr|Mrs|Ms|Miss|Mx|Shri|Smt|Dr)\\.?\\s+";
  s = s.replace(new RegExp(`${HON}(?=${PH.CANDIDATE})`, "g"), () => (hit("honorifics")(1), ""));
  s = s.replace(new RegExp(`${HON}\\p{Lu}[\\p{L}'-]+(?:\\s+\\p{Lu}[\\p{L}'-]+)?`, "gu"), () => (hit("honorifics")(1), PH.REFEREE));
  s = s.replace(/\b(?:Mr|Mrs|Ms|Mx)\.?(?=\s|$)/g, () => (hit("honorifics")(1), ""));

  for (const [re, rep] of PRONOUNS) s = s.replace(re, (m) => (hit("pronouns")(1), matchCase(m, rep)));
  for (const re of DATE_PATTERNS) s = s.replace(re, () => (hit("dates")(1), PH.DATE));
  for (const re of ACADEMIC_PATTERNS) s = s.replace(re, () => (hit("academic")(1), ""));

  return tidy(s);
}

function tidy(s: string): string {
  return s
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:)])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/(\s*[·|,]\s*){2,}/g, " · ")
    .replace(/^[\s·|,]+|[\s·|,]+$/g, "")
    .trim();
}

export function renderPlaceholders(s: string): string {
  return s.replace(/(\w)/g, (_, k) => PH_RENDER[k]);
}

// ---------- unit-level drops ----------

/** True if the unit (a bullet or a sentence) must be dropped entirely. */
export function dropReason(unit: string): "gap" | "personal" | "language" | "relocation" | null {
  if (GAP_PATTERNS.some((re) => re.test(unit))) return "gap";
  if (PERSONAL_PATTERNS.some((re) => re.test(unit))) return "personal";
  // Eligibility is recorded separately and never scored (rubric §4.6), so it must not
  // reach the Scorer either.
  if (RELOCATION_SENTENCE.test(unit)) return "relocation";
  if (LANGUAGE_SENTENCE.test(unit) && LANG_WORD.test(unit)) return "language";
  return null;
}

// Personal relocation statements only; "led the warehouse relocation" is work and is kept.
const RELOCATION_SENTENCE =
  /\b(willing|unwilling|open|happy|able|unable|ready|keen|prepared|not|cannot|can't|won't)\b.{0,25}\b(relocat\w*|move|moving)\b|\b(no|open to) relocation\b|\brelocation (is )?(not )?(possible|an option|preferred)\b|\bnotice period\b/i;

// "Fluent in Marathi and English." A skills entry is handled by stripLanguages instead.
const LANGUAGE_SENTENCE = /\b(fluent|fluency|proficient|proficiency|speak|speaks|spoken|native speaker|mother tongue|languages?)\b/i;

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z\d"'(])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const LANG_WORD = new RegExp(`\\b(${HUMAN_LANGUAGES.join("|")})\\b`);
const LANG_ALL = new RegExp(LANG_WORD.source, "g");
const LANG_PREFIX = /^\s*(spoken\s+)?languages?(\s+(known|spoken))?\s*[:-]\s*/i;

/** Removes human languages from a skills entry. Returns null if nothing else is left. */
export function stripLanguages(skill: string, counts: RedactionCounts): string | null {
  if (!LANG_WORD.test(skill)) return skill;
  const prefix = LANG_PREFIX.exec(skill)?.[0] ?? "";
  const parts = skill.slice(prefix.length).split(/[,;·]/).map((p) => p.trim()).filter(Boolean);
  const kept = parts.filter((p) => !LANG_WORD.test(p));
  counts.languages += skill.match(LANG_ALL)?.length ?? 0;
  if (!kept.length) return null;
  return (prefix ? prefix.trim() + " " : "") + kept.join(", ");
}
