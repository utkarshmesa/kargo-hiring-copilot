import { FLAG_TEXT } from "@/lib/score/labels";

// Tier and flag meanings are always written out: never colour alone (PRD §8.5).
const TIER_STYLE: Record<string, string> = {
  A: "bg-emerald-100 text-emerald-900 border-emerald-300",
  B: "bg-sky-100 text-sky-900 border-sky-300",
  C: "bg-zinc-100 text-zinc-800 border-zinc-300",
  D: "bg-zinc-200 text-zinc-700 border-zinc-400",
  R: "bg-amber-100 text-amber-950 border-amber-300",
};
export const TIER_LABEL: Record<string, string> = {
  A: "Tier A · Shortlist",
  B: "Tier B · Consider",
  C: "Tier C · Hold",
  D: "Tier D · Not a fit for this role",
  R: "Tier R · Please read",
};

export function TierBadge({ tier }: { tier: string | null }) {
  if (!tier) return null;
  return <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${TIER_STYLE[tier]}`}>{TIER_LABEL[tier]}</span>;
}

const FLAG_SHORT: Record<string, string> = {
  WILDCARD: "Wildcard",
  INTEGRITY_CHECK: "Integrity check",
  VERIFY_CLAIM: "Verify claim",
  QUOTE_MISMATCH: "Quote mismatch",
  NO_CONTACT: "No email",
  LEGACY: "Legacy",
  BOUNCED: "Bounced",
  UNSTABLE_SCORE: "Unstable score",
  BELOW_EXPERIENCE_BAND: "Below experience band",
  CONSIDER_SPM: "Consider for SPM",
  CONSIDER_PM: "Consider for PM",
  LEVEL_CHECK: "Level check",
};

export function FlagBadges({ flags }: { flags: string[] }) {
  if (!flags.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {flags.map((f) => (
        <span
          key={f}
          title={FLAG_TEXT[f] ?? f}
          className={`rounded border px-1.5 py-0.5 text-xs ${f === "BOUNCED" ? "border-red-400 bg-red-50 text-red-900" : "border-zinc-300 bg-white text-zinc-700"}`}
        >
          {FLAG_SHORT[f] ?? f}
        </span>
      ))}
    </span>
  );
}
