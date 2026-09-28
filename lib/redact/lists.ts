import { readFileSync } from "node:fs";
import path from "node:path";

// lists/cities.txt and lists/colleges.txt (PRD §10). Extend by editing the files.
function load(file: string): string[] {
  const text = readFileSync(path.join(process.cwd(), "lists", file), "utf8");
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

let cache: { cities: string[]; colleges: string[] } | null = null;
export function lists() {
  if (!cache) cache = { cities: load("cities.txt"), colleges: load("colleges.txt") };
  return cache;
}

// Human languages: removed from skills (rubric §4.1: "may indicate community").
// Programming languages are untouched.
export const HUMAN_LANGUAGES = [
  "English", "Hindi", "Marathi", "Tamil", "Telugu", "Kannada", "Malayalam", "Bengali", "Bangla",
  "Gujarati", "Punjabi", "Urdu", "Odia", "Oriya", "Assamese", "Konkani", "Sanskrit", "Sindhi",
  "Kashmiri", "Nepali", "Tulu", "Bhojpuri", "Maithili", "Manipuri", "French", "German", "Spanish",
  "Portuguese", "Italian", "Japanese", "Mandarin", "Chinese", "Cantonese", "Korean", "Arabic",
  "Russian", "Persian", "Farsi", "Turkish", "Dutch", "Hebrew", "Swahili", "Tagalog", "Thai",
  "Vietnamese", "Indonesian", "Malay",
];

// Gap and break language (rubric §4.1). The whole sentence or bullet is removed,
// because removing only the phrase still leaves the story ("after a 2-year … to care for").
export const GAP_PATTERNS: RegExp[] = [
  /\bcareer[- ](break|gap|pause|restart|returner)\b/i,
  /\bsabbatical\b/i,
  /\bmaternity\b/i,
  /\bpaternity\b/i,
  /\bparental leave\b/i,
  /\bgap year\b/i,
  /\b(took|taking|take) (a |some )?(break|time off|time out)\b/i,
  /\bbreak (in|from) (my )?(career|work|employment)\b/i,
  /\breturn(ed|ing)? to (work|the workforce)\b/i,
  /\b(caregiving|care-giving|caring for (my|a|an|their) )/i,
  /\bfamily (reasons|commitments|responsibilities|emergency)\b/i,
  /\bmedical (leave|reasons)\b/i,
  /\b(employment|career) gap\b/i,
];

// Protected personal details (rubric §4.1). Matching sentences/lines are removed.
export const PERSONAL_PATTERNS: RegExp[] = [
  /\bdate of birth\b/i,
  /\bD\.?O\.?B\.?\b/,
  /\bborn (on|in)\b/i,
  /\bage\s*[:\-]\s*\d/i,
  /\b\d{2}\s*(years|yrs) old\b/i,
  /\bmarital status\b/i,
  /\b(married|unmarried|divorced|widowed)\b/i,
  /\bnationality\b/i,
  /\breligion\b/i,
  /\bcaste\b/i,
  /\bgender\s*[:\-]/i,
  /\bsex\s*[:\-]/i,
  /\b(father|mother|husband|wife|spouse)'?s? name\b/i,
  /\bpassport\s*(no|number|#)/i,
  /\bnative place\b/i,
  /\bhometown\b/i,
  /\bpermanent address\b/i,
];

// Academic scores and honours (rubric §4.1). Only the phrase is removed.
export const ACADEMIC_PATTERNS: RegExp[] = [
  /\b(C?GPA|CPI|SGPA)\s*[:\-]?\s*\d+(\.\d+)?(\s*\/\s*\d+(\.\d+)?)?/gi,
  /\b\d{2}(\.\d+)?\s*%\s*(marks|aggregate|percentile)\b/gi,
  /\b(gold|silver|bronze)\s+medal(l)?ist\b[^·|;,.\n]*/gi,
  /\buniversity (rank|topper)\b[^·|;,.\n]*/gi,
  /\b(first class( with distinction)?|first division|second class|dean'?s list|summa cum laude|magna cum laude|cum laude)\b/gi,
  /\b(AIR|all india rank|rank)\s*[:#]?\s*\d+\b/gi,
];
