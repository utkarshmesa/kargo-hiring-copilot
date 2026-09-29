// PRD Appendix B: the only email wording the system can send. Fixed text; `{{ }}` values are
// filled from data. The single piece of AI-written text allowed anywhere is the Advance
// invite line, and only after Arjun has seen it (and possibly edited it) in the preview.
// Declines contain no AI text at all.

export type RoleTitle = "PM" | "SPM";
export const ROLE_TITLE_TEXT: Record<RoleTitle, string> = { PM: "Product Manager", SPM: "Senior Product Manager" };

export type Rendered = { subject: string; text: string; html: string };

const LEGACY_OPENING = "Apologies for how long it has taken us to get back to you. ";
const RELOCATION_QUESTION = "The role is in-office in Mumbai; let me know if relocation is something you'd consider.";
const SIGNATURE = "Arjun Mehta, Founder, Kargo";
// B.7: every candidate email.
export const PRIVACY_FOOTER =
  "Kargo uses software to help organise applications; every decision is made by a person. To access or delete your data, reply to this email.";

/** "RAHUL BOSE" → "Rahul"; no name → null (the greeting becomes "Hi there,"). */
export function firstName(displayName: string | null): string | null {
  const first = displayName?.trim().split(/\s+/)[0];
  if (!first || !/\p{L}/u.test(first)) return null;
  return first[0].toUpperCase() + first.slice(1).toLowerCase();
}

/** "2026-10-19" → "19 October 2026". */
export function formatDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

type Common = { firstName: string | null; roleTitle: RoleTitle; legacy: boolean };

function greeting(name: string | null) {
  return `Hi ${name ?? "there"},`;
}

function build(subject: string, paragraphs: string[], candidate = true): Rendered {
  const all = candidate ? [...paragraphs, PRIVACY_FOOTER] : paragraphs;
  const text = all.join("\n\n");
  const html = all.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("\n");
  return { subject, text, html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#18181b">${html}</div>` };
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// B.1 Advance
export function renderAdvance(v: Common & { inviteLine: string; bookingUrl: string; askRelocation: boolean }): Rendered {
  const role = ROLE_TITLE_TEXT[v.roleTitle];
  const invite = v.inviteLine.trim();
  return build(`Next step: ${role} at Kargo`, [
    greeting(v.firstName),
    `${v.legacy ? LEGACY_OPENING : ""}Thanks for applying for the ${role} role at Kargo.${invite ? ` ${invite}` : ""}`,
    `I'd like to set up a conversation. Please pick a time that works for you here: ${v.bookingUrl}`,
    ...(v.askRelocation ? [RELOCATION_QUESTION] : []),
    `Looking forward to it,\n${SIGNATURE}`,
  ]);
}

// B.2 Decline: no AI text, no scores, no reasons.
export function renderDecline(v: Common): Rendered {
  const role = ROLE_TITLE_TEXT[v.roleTitle];
  return build(`Your application for ${role} at Kargo`, [
    greeting(v.firstName),
    `${v.legacy ? LEGACY_OPENING : ""}Thank you for taking the time to apply for the ${role} role at Kargo. We've reviewed your application carefully and have decided not to move forward with it for this role.`,
    "We appreciate your interest in Kargo and wish you the very best in your search.",
    SIGNATURE,
  ]);
}

// B.3 Hold
export function renderHold(v: Common & { holdUntil: string }): Rendered {
  const role = ROLE_TITLE_TEXT[v.roleTitle];
  return build(`Update on your application: ${role} at Kargo`, [
    greeting(v.firstName),
    `${v.legacy ? LEGACY_OPENING : ""}Thank you for applying for the ${role} role. We're still reviewing applications and will get back to you by ${formatDate(v.holdUntil)}.`,
    SIGNATURE,
  ]);
}

// B.4 Not-booked nudge (once, 3 days after Advance)
export function renderNudge(v: { firstName: string | null; roleTitle: RoleTitle; bookingUrl: string }): Rendered {
  const role = ROLE_TITLE_TEXT[v.roleTitle];
  return build(`Re: Next step: ${role} at Kargo`, [
    `${greeting(v.firstName)} just checking this reached you. If you'd still like to talk, you can pick a time here: ${v.bookingUrl}. Arjun`,
  ]);
}

// B.6 Arjun digest (to ARJUN_EMAIL only; never a candidate)
export type DigestData = {
  nWaiting: number;
  oldestDays: number;
  dashboardUrl: string;
  weeksLeft: number;
  holdsDue: string[];
  interviewedStale: string[];
  notBooked: string[];
  bounced: string[];
  counts: { advanced: number; booked: number; interviewed: number; offer: number };
};

export function renderDigest(d: DigestData): Rendered {
  const list = (xs: string[]) => (xs.length ? `${xs.length} (${xs.join(", ")})` : "0");
  return build(
    `Hiring: ${d.nWaiting} waiting · ${d.weeksLeft} weeks to target`,
    [
      ...(d.holdsDue.length ? [`Holds due today: decide again on ${d.holdsDue.join(", ")}.`] : []),
      [
        `- Waiting for your decision: ${d.nWaiting} (oldest ${d.oldestDays} days): ${d.dashboardUrl}/shortlist`,
        `- Holds due today: ${list(d.holdsDue)}`,
        `- Interviewed, no next step: ${list(d.interviewedStale)}`,
        `- Advanced, not booked (nudged): ${list(d.notBooked)}`,
        `- Bounced emails: ${list(d.bounced)}`,
        `- Pipeline: Advanced ${d.counts.advanced} · Booked ${d.counts.booked} · Interviewed ${d.counts.interviewed} · Offer ${d.counts.offer}`,
      ].join("\n"),
    ],
    false,
  );
}
