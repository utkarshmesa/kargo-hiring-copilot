import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { candidates, evaluations } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

type DimView = {
  id: string;
  score: number;
  evidence_status: string;
  confidence: string;
  runScores: number[];
  quoteMismatch: boolean;
  evidence: { quote: string }[];
};

// Phase 1 view: identity (Arjun only) beside exactly what the AI will see.
// The full candidate card (scores, quotes, probes, decisions) arrives in Phase 3.
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
  const log = (ev.redactionLogJson ?? {}) as Record<string, unknown>;

  return (
    <article className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{cand.displayName ?? cand.fileName ?? "Candidate"}</h1>
        <p className="text-sm text-zinc-600">
          {cand.email ?? "no email on CV"} · applied for {ev.roleApplied} · status {ev.status}
          {ev.tier ? ` · tier ${ev.tier}` : ""}
          {ev.tierReason ? ` (${ev.tierReason})` : ""}
        </p>
        <p className="text-sm">
          Flags: {ev.flags.length ? ev.flags.join(", ") : "none"} · Relocation: {cand.eligibilityRelocate}
          {cand.linkedCandidateIds.length ? ` · linked to ${cand.linkedCandidateIds.length} other record(s)` : ""}
        </p>
        <a href={`/api/cv/${ev.id}`} className="text-sm text-blue-700 hover:underline">
          View original CV
        </a>
      </header>

      {ev.pmTotal !== null ? (
        <section className="rounded border bg-white p-4 text-sm">
          <h2 className="font-medium">Scores (full candidate card arrives in Phase 3)</h2>
          <p className="mt-1">
            PM total {ev.pmTotal.toFixed(1)} · SPM total {ev.spmTotal?.toFixed(1)} · Core {ev.coreScore?.toFixed(1)} · best fit {ev.bestFitRole}
          </p>
          <ul className="mt-2 space-y-1">
            {Object.values(((ev.dimsFinalJson as { dims?: Record<string, DimView> } | null)?.dims ?? {}) as Record<string, DimView>).map((d) => (
              <li key={d.id}>
                <strong>{d.id}</strong> {d.score} ({d.evidence_status}, {d.confidence}, runs {d.runScores.join("/")})
                {d.quoteMismatch ? " · quote mismatch" : ""}
                {d.evidence[0] ? <span className="text-zinc-600"> · “{d.evidence[0].quote}”</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2 className="font-medium">Redacted profile (the only text the Scorer and Writer receive)</h2>
        {ev.redactedProfileText ? (
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded border bg-white p-4 text-sm">{ev.redactedProfileText}</pre>
        ) : (
          <p className="mt-2 text-sm text-zinc-600">Not available{ev.tierReason ? `: ${ev.tierReason}` : " yet"}.</p>
        )}
      </section>

      <section>
        <h2 className="font-medium">Redaction log</h2>
        <pre className="mt-2 overflow-x-auto rounded border bg-white p-4 text-xs">{JSON.stringify(log, null, 2)}</pre>
      </section>
    </article>
  );
}
