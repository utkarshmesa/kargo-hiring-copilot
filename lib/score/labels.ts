// Plain-English names and meanings, for the Writer's input and the dashboard.
export const DIM_NAMES: Record<string, string> = {
  D1: "Ground-level operations exposure",
  D2: "Self-initiated problem solving, adopted by others",
  D3: "Ownership without structure",
  D4: "Shipped, killed, learned",
  D5: "Customer-outcome orientation and discovery",
  D6: "Owns the recovery when things break",
  D7: "Experience fit (role band)",
  D8: "Platform, integration and data-layer depth",
  D9: "Building the product function",
};

// Rubric §9, in plain English.
export const FLAG_TEXT: Record<string, string> = {
  WILDCARD: "Strong operator-builder outside logistics: listed beside Tier A. Tier unchanged.",
  INTEGRITY_CHECK: "Hidden text, injected instructions or rubric-like phrasing was found and removed. Genuine content was still scored.",
  VERIFY_CLAIM: "At least one dimension scored 4. A verification probe is included.",
  QUOTE_MISMATCH: "The AI quoted text that is not in the CV; that dimension was set to 0.",
  NO_CONTACT: "No email address on the CV: this candidate can't be emailed.",
  LEGACY: "Applied before this system existed. Emails open with an apology.",
  BOUNCED: "An email to this candidate bounced.",
  UNSTABLE_SCORE: "The three scoring runs disagreed by 2 or more on a dimension. Please read the CV.",
  BELOW_EXPERIENCE_BAND: "PM-relevant experience is below the floor for this role.",
  CONSIDER_SPM: "Applied for PM but has more than 5 years of PM-relevant experience and strong ownership: consider for Senior PM.",
  CONSIDER_PM: "Applied for Senior PM with under 4 years of PM-relevant experience: consider for PM.",
  LEVEL_CHECK: "Over 10 years of PM-relevant experience: may expect a Head of Product role.",
};

export const TIER_REASON_TEXT: Record<string, string> = {
  unparseable: "Too little readable text (under 150 words) or the file could not be read.",
  extraction_fidelity: "The AI's split of the CV did not match the original text, even after a retry.",
  redaction_leak: "Identity details could not be fully removed, so the AI was not given this CV.",
  invalid_output: "The AI's output was invalid after retries.",
  unparseable_dates: "The dates of a PM or product-owning role could not be read, so experience can't be computed.",
  unstable_score: "The three scoring runs disagreed too much.",
  quote_mismatch: "Three or more dimensions had quotes not found in the CV.",
  absent_evidence: "Three or more dimensions have no evidence in the CV (a thin CV is never a decline).",
  insufficient_evidence: "Total below 40 without enough evidence to recommend a decline.",
  capped_pm_experience_floor: "Capped at B: under the PM experience floor.",
  capped_spm_experience_floor: "Capped at B: under the Senior PM experience floor.",
  capped_experience_band: "Capped at B: outside the experience band (strict mode).",
  capped_d1_gate: "Capped at B: D1 below 2 (D1 gate is on).",
};
