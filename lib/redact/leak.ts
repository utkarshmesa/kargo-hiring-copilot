import { lists } from "./lists";
import { EMAIL_RE, NOT_A_COUNT, PHONE_RE, URL_RE, YEAR, termRegex, type Terms } from "./redact";

// Step 5.5: the leak check. Runs on the final rendered profile. Any hit → needs_review
// (tier R, redaction_leak). Returns categories only: the leaked values are never logged.

export type LeakCategory =
  | "name_not_found"
  | "name"
  | "email"
  | "phone"
  | "url"
  | "location"
  | "institution"
  | "company"
  | "city_list"
  | "college_list"
  | "date"
  | "gendered_word";

const MONTH_YEAR = new RegExp(
  `\\b(Jan(uary)?|Feb(ruary)?|Mar(ch)?|Apr(il)?|May|June?|July?|Aug(ust)?|Sep(t(ember)?)?|Oct(ober)?|Nov(ember)?|Dec(ember)?)\\.?,?\\s*${YEAR}\\b`,
  "i",
);
const BARE_YEAR = new RegExp(`(?<![₹$€£#\\d.,])\\b${YEAR}\\b${NOT_A_COUNT}`);
const GENDERED = /\b(he|she|him|her|his|hers|himself|herself)\b/i;
// Honorifics are case-sensitive so "MS Excel" is not a leak.
const HONORIFIC = /\b(Mr|Mrs|Ms|Miss|Smt|Shri)\b\.?(?=\s)/;

export function checkLeaks(profileText: string, terms: Terms): LeakCategory[] {
  // Placeholders are ours; strip them so their letters can't match a term.
  const text = profileText.replace(/\[(CANDIDATE|COMPANY|INSTITUTION|LOCATION|REFEREE|DATE)\]/g, " ");
  const found = new Set<LeakCategory>();
  const any = (values: string[]) => values.some((v) => v.trim().length >= 2 && termRegex(v).test(text));

  if (!terms.names.length) found.add("name_not_found");
  if (any(terms.names)) found.add("name");
  if (new RegExp(EMAIL_RE.source).test(text) || any(terms.emails)) found.add("email");
  const digits = [...text.matchAll(new RegExp(PHONE_RE.source, "g"))].some((m) => m[0].replace(/\D/g, "").length >= 10);
  const phoneDigits = terms.phones.map((p) => p.replace(/\D/g, "")).filter((d) => d.length >= 7);
  if (digits || phoneDigits.some((d) => text.replace(/\D/g, "").includes(d))) found.add("phone");
  if (new RegExp(URL_RE.source, "i").test(text) || any(terms.urls)) found.add("url");
  if (any(terms.locations)) found.add("location");
  if (any(terms.institutions)) found.add("institution");
  if (any(terms.companies)) found.add("company");
  const { cities, colleges } = lists();
  if (any(cities)) found.add("city_list");
  if (any(colleges)) found.add("college_list");
  if (MONTH_YEAR.test(text) || BARE_YEAR.test(text)) found.add("date");
  if (GENDERED.test(text) || HONORIFIC.test(text)) found.add("gendered_word");
  return [...found];
}
