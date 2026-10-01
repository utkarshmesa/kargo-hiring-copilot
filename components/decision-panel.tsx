"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatDate } from "@/lib/email/templates";

// US5 / US6: decide in one click, with the exact email previewed; Undo until it sends.
type Role = "PM" | "SPM";
type Action = "advance" | "decline" | "hold";
export type DecisionPanelProps = {
  evaluationId: string;
  processing: boolean;
  pipelineStatus: string;
  roleApplied: "PM" | "SPM" | "NOT_SURE";
  bestFitRole: Role | null;
  noContact: boolean;
  draftInvite: string;
  holdDefault: string;
  /** Rendered from the fixed templates; "{{INVITE}}" and "{{DATE}}" are filled in here. */
  previews: Record<Role, Record<Action, { subject: string; text: string }>>;
  active: { decisionId: string; action: Action; emailStatus: string | null; scheduledAt: string | null; decidedAt: string } | null;
  undoWindowEnds: string | null;
  linkedOpen: string[];
  statusMoves: string[];
  history: { kind: string; status: string; at: string }[];
};

const ALLOWED: Record<Action, string[]> = {
  advance: ["scored", "hold"],
  hold: ["scored", "hold"],
  decline: ["scored", "hold", "advanced", "booked", "interviewed"],
};
const LABEL: Record<string, string> = { booked: "Mark booked", interviewed: "Mark interviewed", offer: "Mark offer made", withdrawn: "Candidate withdrew" };

function useCountdown(until: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  if (!until) return null;
  const ms = new Date(until).getTime() - now;
  if (ms <= 0) return null;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return h ? `${h}h ${m}m` : `${m}:${String(s).padStart(2, "0")}`;
}

export default function DecisionPanel(p: DecisionPanelProps) {
  const router = useRouter();
  const [open, setOpen] = useState<Action | null>(null);
  const [reason, setReason] = useState("");
  const [invite, setInvite] = useState(p.draftInvite);
  const [holdUntil, setHoldUntil] = useState(p.holdDefault);
  const [role, setRole] = useState<Role>(p.roleApplied === "NOT_SURE" ? (p.bestFitRole ?? "PM") : p.roleApplied);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const waiting = p.active?.emailStatus === "scheduled" || p.active?.emailStatus === "pending";
  const countdown = useCountdown(waiting ? p.active!.scheduledAt : p.undoWindowEnds);
  // Due but not yet handed to Resend: the dashboard's sender picks it up within 30 s.
  const sendingNow = waiting && !countdown;

  async function post(url: string, body: object, done: string) {
    setBusy(true);
    setMessage(null);
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    setMessage(res.ok ? { ok: true, text: done } : { ok: false, text: json.error ?? "Something went wrong." });
    if (res.ok) setOpen(null);
    router.refresh();
  }

  async function confirmDecision(action: Action) {
    if (action === "decline" && p.linkedOpen.length && !confirm(`This person also applied for ${p.linkedOpen.join(", ")}, which is still open. Decline this application anyway?`)) return;
    await post(
      "/api/decide",
      {
        evaluation_id: p.evaluationId,
        action,
        reason: reason || null,
        hold_until: action === "hold" ? holdUntil : null,
        invite_line_override: action === "advance" ? invite : null,
        role_title: p.roleApplied === "NOT_SURE" ? role : null,
      },
      p.noContact ? "Decision saved. No email: there is no address on the CV." : "Decision saved. The email is scheduled.",
    );
  }

  const preview = (action: Action) => {
    const pv = p.previews[role][action];
    const fill = (s: string) => s.replace(" {{INVITE}}", invite.trim() ? ` ${invite.trim()}` : "").replace("{{DATE}}", holdUntil ? formatDate(holdUntil) : "[date]");
    return { subject: fill(pv.subject), text: fill(pv.text) };
  };

  if (p.processing) return <Box>Decisions are available once this CV has finished processing.</Box>;

  return (
    <section className="space-y-3 rounded-lg border bg-white p-4" aria-label="Decision">
      <h2 className="font-medium">Decision</h2>

      {p.active && countdown ? (
        <div className="flex flex-wrap items-center gap-3 rounded border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-950" role="status">
          <span>
            {p.active.action[0].toUpperCase() + p.active.action.slice(1)} {p.noContact ? "saved (no email)" : "email"} · sending in <strong>{countdown}</strong>
          </span>
          <button type="button" disabled={busy} onClick={() => post("/api/undo", { decision_id: p.active!.decisionId }, "Undone. You can decide again.")} className="rounded border border-sky-500 bg-white px-3 py-1 hover:bg-sky-100">
            Undo
          </button>
        </div>
      ) : null}

      {p.noContact ? <p className="text-sm text-amber-900">No email on CV: decisions are recorded, but nothing can be sent.</p> : null}

      {sendingNow ? (
        <p role="status" className="rounded border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-950">
          {p.active!.action[0].toUpperCase() + p.active!.action.slice(1)} email · sending now…
        </p>
      ) : null}

      {!(p.active && countdown) && !sendingNow ? (
        <div className="flex flex-wrap gap-2">
          {(["advance", "hold", "decline"] as Action[])
            .filter((a) => ALLOWED[a].includes(p.pipelineStatus))
            .map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setOpen(open === a ? null : a)}
                aria-expanded={open === a}
                className={`rounded px-4 py-2 text-sm font-medium ${a === "advance" ? "bg-emerald-700 text-white hover:bg-emerald-800" : a === "decline" ? "border border-zinc-400 hover:bg-zinc-50" : "border border-sky-400 hover:bg-sky-50"}`}
              >
                {a === "advance" ? "Advance" : a === "hold" ? "Hold" : "Decline"}
              </button>
            ))}
          {p.statusMoves.map((s) => (
            <button key={s} type="button" disabled={busy} onClick={() => post("/api/status", { evaluation_id: p.evaluationId, status: s }, "Status updated.")} className="rounded border px-3 py-2 text-sm hover:bg-zinc-50">
              {LABEL[s] ?? s}
            </button>
          ))}
        </div>
      ) : null}

      {open ? (
        <div className="space-y-3 rounded border bg-zinc-50 p-3 text-sm">
          {p.roleApplied === "NOT_SURE" ? (
            <label className="block">
              Role title in the email
              <select value={role} onChange={(e) => setRole(e.target.value as Role)} className="ml-2 rounded border px-2 py-1">
                <option value="PM">Product Manager</option>
                <option value="SPM">Senior Product Manager</option>
              </select>
            </label>
          ) : null}
          {open === "advance" ? (
            <label className="block">
              Personal line (the only line you can edit; AI draft, max 300 characters)
              <input value={invite} maxLength={300} onChange={(e) => setInvite(e.target.value)} className="mt-1 block w-full rounded border px-2 py-1.5" />
            </label>
          ) : null}
          {open === "hold" ? (
            <label className="block">
              Get back to them by
              <input type="date" value={holdUntil} onChange={(e) => setHoldUntil(e.target.value)} className="ml-2 rounded border px-2 py-1" />
            </label>
          ) : null}
          <label className="block">
            Reason (optional, for your records; never emailed)
            <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} className="mt-1 block w-full rounded border px-2 py-1.5" />
          </label>
          {!p.noContact ? (
            <div className="rounded border bg-white p-3">
              <p className="text-xs text-zinc-500">
                Email preview · sends {open === "decline" ? "24 hours" : "10 minutes"} after you confirm; Undo until then
              </p>
              <p className="mt-1 font-medium">{preview(open).subject}</p>
              <pre className="mt-1 whitespace-pre-wrap font-sans text-sm">{preview(open).text}</pre>
            </div>
          ) : null}
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => confirmDecision(open)} className="rounded bg-zinc-900 px-4 py-2 text-white hover:bg-zinc-700 disabled:opacity-50">
              Confirm {open}
            </button>
            <button type="button" onClick={() => setOpen(null)} className="rounded border px-4 py-2 hover:bg-white">
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {message ? (
        <p role="status" className={`text-sm ${message.ok ? "text-emerald-800" : "text-red-800"}`}>
          {message.text}
        </p>
      ) : null}

      {p.history.length ? (
        <div className="text-xs text-zinc-600">
          <p className="font-medium">Emails</p>
          <ul>
            {p.history.map((h, i) => (
              <li key={i} className={h.status === "bounced" ? "font-semibold text-red-800" : ""}>
                {h.kind} · {h.status} · {new Date(h.at).toLocaleString()}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function Box({ children }: { children: React.ReactNode }) {
  return <section className="rounded-lg border border-dashed bg-white p-4 text-sm text-zinc-600">{children}</section>;
}
