import { eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FlagBadges, TierBadge } from "@/components/badges";
import DecisionPanel from "@/components/decision-panel";
import { decisionPanelProps } from "@/lib/decision-view";
import { betterFit, daysSince, PIPELINE_LABEL, rankedTotal, ROLE_LABEL } from "@/lib/dashboard";
import { db } from "@/lib/db/client";
import { candidates, evaluations } from "@/lib/db/schema";
import type { Brief } from "@/lib/gemini/writer";
import type { FinalDim } from "@/lib/score/combine";
import type { Experience } from "@/lib/score/experience";
import { DIM_NAMES, FLAG_TEXT, TIER_REASON_TEXT } from "@/lib/score/labels";

export const dynamic = "force-dynamic";

type DimsFinal = { dims: Record<string, FinalDim>; d7: { PM: number; SPM: number }; roleUsed: "PM" | "SPM" };

const RELOCATION_TEXT: Record<string, string> = {
  stated_yes: "Mumbai-based or willing to relocate (stated).",
  stated_no: "Stated they are not willing to relocate. This never changes the score or tier.",
  unstated: "Relocation not stated. Not a negative; the invite asks about it.",
};

// US4: understand one candidate in 20 seconds. Summary first, then evidence.
export default async function CandidatePage({ params }: PageProps<"/candidates/[id]">) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const database = db();
  const [row] = await database
    .select({ ev: evaluations, cand: candidates })
    .from(evaluations)
    .innerJoin(candidates, eq(candidates.id, evaluations.candidateId))
    .where(eq(evaluations.id, id));
  if (!row) notFound();
  const { ev, cand } = row;

  const linked = cand.linkedCandidateIds.length
    ? await database
        .select({ id: evaluations.id, roleApplied: evaluations.roleApplied, pipelineStatus: evaluations.pipelineStatus })
        .from(evaluations)
        .where(inArray(evaluations.candidateId, cand.linkedCandidateIds))
    : [];

  const panel = await decisionPanelProps(database, ev, cand, linked);
  const final = ev.dimsFinalJson as DimsFinal | null;
  const brief = ev.briefJson as (Brief & { removed?: string[] }) | null;
  const experience = ev.experienceJson as Experience | null;
  const roleUsed = final?.roleUsed ?? (ev.roleApplied === "SPM" ? "SPM" : "PM");
  const fit = betterFit({ roleUsed, roleApplied: ev.roleApplied, pmTotal: ev.pmTotal, spmTotal: ev.spmTotal });
  const dimOrder = ["D1", "D2", "D3", "D4", "D5", "D6", "D8", "D9"];

  return (
    <article className="space-y-6">
      <header className="space-y-2">
        <p className="text-sm">
          <Link href="/shortlist" className="text-zinc-600 hover:underline">
            ← Shortlist
          </Link>
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{cand.displayName ?? cand.fileName ?? "Candidate"}</h1>
          <TierBadge tier={ev.tier} />
          <FlagBadges flags={ev.flags} />
        </div>
        <p className="text-sm text-zinc-700">
          {cand.email ?? <strong>No email on CV: this candidate can&apos;t be emailed.</strong>} · applied for {ROLE_LABEL[ev.roleApplied]}
          {ev.bestFitRole ? ` · best fit ${ROLE_LABEL[ev.bestFitRole]}` : ""} · {PIPELINE_LABEL[ev.pipelineStatus ?? "scored"] ?? ev.status}
          {ev.pipelineStatusAt ? ` for ${daysSince(ev.pipelineStatusAt)} day(s)` : ""}
        </p>
        {linked.map((l) => (
          <p key={l.id} className="rounded border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm text-amber-950">
            Also applied for {ROLE_LABEL[l.roleApplied]} (
            <Link href={`/candidates/${l.id}`} className="underline">
              {PIPELINE_LABEL[l.pipelineStatus ?? "scored"] ?? "processing"}
            </Link>
            ). Each application is decided separately.
          </p>
        ))}
        <p className="text-sm">
          <a href={`/api/cv/${ev.id}?view=1`} target="_blank" rel="noopener" className="text-blue-700 hover:underline">
            View original CV
          </a>
        </p>
      </header>

      <DecisionPanel {...panel} />

      {ev.tier === "R" && ev.tierReason ? (
        <section className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
          <h2 className="font-medium">Please read the CV: no recommendation</h2>
          <ul className="mt-1 list-disc pl-5">
            {ev.tierReason.split(", ").map((k) => (
              <li key={k}>{TIER_REASON_TEXT[k] ?? k}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {ev.pmTotal !== null ? (
        <section className="grid gap-4 md:grid-cols-3">
          <Stat label={`${roleUsed === "PM" ? "PM" : "Senior PM"} total (tier basis)`} value={rankedTotal({ roleUsed, roleApplied: ev.roleApplied, pmTotal: ev.pmTotal, spmTotal: ev.spmTotal }).toFixed(1)} />
          <Stat label={`${roleUsed === "PM" ? "Senior PM" : "PM"} total`} value={((roleUsed === "PM" ? ev.spmTotal : ev.pmTotal) ?? 0).toFixed(1)} note={fit ? `Better fit for ${ROLE_LABEL[fit]}` : undefined} />
          <Stat label="Core Kargo score (D1–D6)" value={(ev.coreScore ?? 0).toFixed(1)} note="Fits Kargo, separate from fits the level" />
        </section>
      ) : null}
      {ev.tier !== "R" && ev.tierReason ? (
        <p className="text-sm text-zinc-700">
          {ev.tierReason
            .split(", ")
            .map((k) => TIER_REASON_TEXT[k] ?? k)
            .join(" ")}
        </p>
      ) : null}

      {brief ? (
        <section className="space-y-3 rounded-lg border bg-white p-4">
          <h2 className="font-medium">Why ranked here</h2>
          <p>{brief.why_ranked_here || "—"}</p>
          <div className="grid gap-4 md:grid-cols-2">
            <List title="Top strengths" items={brief.top_strengths} />
            <List title="Top gaps (weak dimensions)" items={brief.top_gaps} />
          </div>
          <List title="Interview probes" items={brief.interview_probes} ordered />
          <p className="text-sm text-zinc-700">
            <strong>What would change this score:</strong> {brief.what_would_change_this_score}
          </p>
          {brief.removed?.length ? <p className="text-xs text-zinc-500">Removed by the safety check: {brief.removed.join(", ")}.</p> : null}
        </section>
      ) : ev.status === "scored" || ev.status === "needs_review" ? (
        <p className="text-sm text-zinc-600">Brief unavailable for this candidate.</p>
      ) : null}

      {final ? (
        <section className="rounded-lg border bg-white p-4">
          <h2 className="font-medium">Scores and evidence</h2>
          <p className="text-xs text-zinc-600">Every score traces to a verbatim quote from the redacted CV. Median of 3 independent runs.</p>
          <ol className="mt-3 space-y-4">
            {dimOrder.slice(0, 6).map((k) => (
              <DimRow key={k} d={final.dims[k]} />
            ))}
            <li className="border-t pt-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <strong>D7 · {DIM_NAMES.D7}</strong>
                <span>
                  PM {final.d7.PM}/4 · Senior PM {final.d7.SPM}/4
                </span>
              </div>
              {experience ? (
                <p className="text-sm text-zinc-700">
                  {experience.pmRelevantYears} years of PM-relevant experience, computed in code:{" "}
                  {experience.roles
                    .filter((r) => r.rate > 0)
                    .map((r) => `role ${r.roleIndex} ${r.type} ${r.months ?? "?"} months × ${r.rate * 100}%`)
                    .join("; ") || "no PM or product-owning roles"}
                  .
                </p>
              ) : null}
            </li>
            {dimOrder.slice(6).map((k) => (
              <DimRow key={k} d={final.dims[k]} note={roleUsed === "PM" ? "Senior PM only; not in this candidate's tier total" : undefined} />
            ))}
          </ol>
        </section>
      ) : null}

      {ev.flags.length ? (
        <section className="rounded-lg border bg-white p-4">
          <h2 className="font-medium">Flags</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {ev.flags.map((f) => (
              <li key={f}>
                <strong>{f}</strong>: {FLAG_TEXT[f] ?? f}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="rounded-lg border bg-white p-4 text-sm">
        <h2 className="font-medium">Relocation (recorded, never scored)</h2>
        <p>{RELOCATION_TEXT[cand.eligibilityRelocate]}</p>
      </section>

      <details className="rounded-lg border bg-white p-4">
        <summary className="cursor-pointer font-medium">What the AI saw (redacted profile)</summary>
        {ev.redactedProfileText ? (
          <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-sm">{ev.redactedProfileText}</pre>
        ) : (
          <p className="mt-2 text-sm">Not available{ev.tierReason ? `: ${TIER_REASON_TEXT[ev.tierReason] ?? ev.tierReason}` : ""}.</p>
        )}
        <h3 className="mt-4 text-sm font-medium">Audit</h3>
        <p className="text-xs text-zinc-600">
          model {ev.modelId ?? "—"} · rubric {ev.rubricHash?.slice(0, 12) ?? "—"} · config {ev.configHash?.slice(0, 12) ?? "—"} · scored{" "}
          {ev.scoredAt?.toISOString() ?? "—"}
        </p>
        <pre className="mt-2 overflow-x-auto text-xs">{JSON.stringify(ev.redactionLogJson ?? {}, null, 2)}</pre>
      </details>
    </article>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border bg-white p-4">
      <p className="text-xs text-zinc-600">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
      {note ? <p className="text-xs text-zinc-600">{note}</p> : null}
    </div>
  );
}

function List({ title, items, ordered }: { title: string; items: string[]; ordered?: boolean }) {
  const Tag = ordered ? "ol" : "ul";
  return (
    <div>
      <h3 className="text-sm font-medium">{title}</h3>
      <Tag className={`mt-1 space-y-1 pl-5 text-sm ${ordered ? "list-decimal" : "list-disc"}`}>
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </Tag>
    </div>
  );
}

function DimRow({ d, note }: { d: FinalDim; note?: string }) {
  return (
    <li className="border-t pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline gap-2">
        <strong>
          {d.id} · {DIM_NAMES[d.id]}
        </strong>
        <span className="text-lg font-semibold">{d.score}/4</span>
        <span className="text-xs text-zinc-600">
          evidence {d.evidence_status} · confidence {d.confidence} · runs {d.runScores.join(" / ")}
        </span>
        {note ? <span className="text-xs text-zinc-500">({note})</span> : null}
      </div>
      {d.quoteMismatch ? (
        <p className="text-sm text-red-800">The AI&apos;s quote was not found in the CV, so this dimension was set to 0.</p>
      ) : (
        d.evidence.map((e) => (
          <blockquote key={e.quote} className="mt-1 border-l-2 border-zinc-300 pl-3 text-sm text-zinc-800">
            “{e.quote}”
          </blockquote>
        ))
      )}
      {!d.quoteMismatch ? <p className="mt-1 text-sm text-zinc-600">{d.rationale}</p> : null}
      {d.capped ? <p className="text-xs text-zinc-500">Capped at 1: evidence only in the summary, skills or education.</p> : null}
      {d.reuseNote ? <p className="text-xs text-zinc-500">{d.reuseNote}</p> : null}
    </li>
  );
}
