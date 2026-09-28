import type { ExtractorOutput } from "@/lib/gemini/extractor";
import { sha256Text } from "@/lib/hash";
import { parseCv, type ParsedCv } from "@/lib/parse";
import { checkFidelity, type FidelityResult } from "@/lib/redact/fidelity";
import { checkLeaks, type LeakCategory } from "@/lib/redact/leak";
import { buildRedactedProfile, type RedactedProfile } from "@/lib/redact/profile";

// Steps 2, 4 and 5 for one CV, without the database: parse and guard → Extractor →
// fidelity (one Extractor retry) → redaction → leak check.

export type Extract = (cvText: string) => Promise<ExtractorOutput>;

export type PrepareResult =
  | { kind: "unparseable"; parsed: ParsedCv }
  | { kind: "extraction_fidelity"; parsed: ParsedCv; extractor: ExtractorOutput; fidelity: FidelityResult }
  | { kind: "redaction_leak"; parsed: ParsedCv; extractor: ExtractorOutput; fidelity: FidelityResult; leaks: LeakCategory[] }
  | {
      kind: "ok";
      parsed: ParsedCv;
      extractor: ExtractorOutput;
      fidelity: FidelityResult;
      profile: RedactedProfile;
      visibleTextHash: string;
    };

export async function prepareProfile(opts: {
  bytes: Uint8Array;
  asOf: Date;
  extract: Extract;
  /** A previously stored Extractor output (a retry after a later-stage failure). */
  cachedExtractor?: ExtractorOutput | null;
}): Promise<PrepareResult> {
  const parsed = await parseCv(opts.bytes);
  if (parsed.unparseable) return { kind: "unparseable", parsed };

  let extractor = opts.cachedExtractor ?? (await opts.extract(parsed.text));
  let fidelity = checkFidelity(parsed.text, extractor);
  if (!fidelity.ok) {
    // PRD Step 5.1: retry the Extractor once, then needs_review.
    extractor = await opts.extract(parsed.text);
    fidelity = checkFidelity(parsed.text, extractor);
    if (!fidelity.ok) return { kind: "extraction_fidelity", parsed, extractor, fidelity };
  }

  const profile = buildRedactedProfile(extractor, opts.asOf);
  const leaks = checkLeaks(profile.text, profile.terms);
  if (leaks.length) return { kind: "redaction_leak", parsed, extractor, fidelity, leaks };

  return { kind: "ok", parsed, extractor, fidelity, profile, visibleTextHash: sha256Text(parsed.text) };
}
