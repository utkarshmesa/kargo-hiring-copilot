import type { ExtractorOutput } from "@/lib/gemini/extractor";
import { hmac, sha256 } from "@/lib/hash";

// Step 5.2–5.3: identity split, record key, eligibility. All of this goes to `candidates`
// and never into anything a model sees.

export function recordKey(ex: ExtractorOutput, fileBytes: Uint8Array): string {
  const secret = process.env.HMAC_SECRET;
  if (!secret) throw new Error("HMAC_SECRET is not set");
  const email = ex.identity.emails.find((e) => e.includes("@"));
  if (email) return `e:${hmac(secret, email.trim().toLowerCase())}`;
  const phone = ex.identity.phones.map((p) => p.replace(/\D/g, "")).find((d) => d.length >= 8);
  if (phone) return `p:${hmac(secret, phone.slice(-10))}`;
  return `f:${sha256(Buffer.from(fileBytes))}`;
}

export type Eligibility = "stated_yes" | "stated_no" | "unstated";

const NO = /\b(not|unwilling|unable|cannot|can't|won't|no)\b.{0,25}\b(relocat\w*|move|moving)\b|\bno relocation\b/i;
const YES = /\b(willing|open|happy|ready|able|keen|plan(ning)?)\b.{0,20}\b(to )?(relocat\w*|move)\b|\brelocating to mumbai\b|\bmumbai[- ]based\b|\bbased in mumbai\b/i;

// rubric §4.6: mumbai_or_relocate. "unstated" is the default and is not a negative.
export function eligibility(ex: ExtractorOutput): Eligibility {
  const statement = ex.relocation_statement ?? "";
  if (NO.test(statement)) return "stated_no";
  if (YES.test(statement)) return "stated_yes";
  if (ex.identity.locations.some((l) => /\b(mumbai|bombay|navi mumbai|thane)\b/i.test(l))) return "stated_yes";
  return "unstated";
}
