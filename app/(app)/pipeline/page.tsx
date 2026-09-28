import Link from "next/link";
import { FlagBadges, TierBadge } from "@/components/badges";
import { daysSince, PIPELINE_LABEL, poolRows, ROLE_LABEL, type Row } from "@/lib/dashboard";
import { weeksLeft } from "@/lib/dates";
import { db } from "@/lib/db/client";
import { currentPool, poolConfig } from "@/lib/pools";

export const dynamic = "force-dynamic";

const ORDER = ["offer", "interviewed", "booked", "advanced", "hold", "scored", "declined", "withdrawn"];
const PROCESSING: Record<string, string> = { queued: "Queued", processing: "Processing", failed: "Failed (retry on Upload)" };

// US7: everyone, with a status, days in status and the weeks left to the offer target.
export default async function PipelinePage() {
  let rows: Row[];
  let target: string;
  try {
    const pool = await currentPool(db());
    rows = await poolRows(db(), pool);
    target = poolConfig(pool).offerTargetDate;
  } catch {
    return <p className="text-sm text-zinc-600">The database is not connected yet.</p>;
  }
  const status = (r: Row) => r.pipelineStatus ?? r.status;
  const sorted = [...rows].sort((a, b) => {
    const ia = ORDER.indexOf(a.pipelineStatus ?? "");
    const ib = ORDER.indexOf(b.pipelineStatus ?? "");
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || (daysSince(b.pipelineStatusAt) ?? 0) - (daysSince(a.pipelineStatusAt) ?? 0);
  });
  const count = (s: string) => rows.filter((r) => r.pipelineStatus === s).length;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Pipeline</h1>
        <p className="text-sm">
          <strong>{weeksLeft(target)} weeks</strong> left to the offer target ({target})
        </p>
      </div>
      <p className="text-sm text-zinc-700">
        Awaiting decision {count("scored")} · Advanced {count("advanced")} · Booked {count("booked")} · Interviewed {count("interviewed")} · Offer{" "}
        {count("offer")} · Hold {count("hold")} · Declined {count("declined")}
      </p>
      <div className="overflow-x-auto rounded-lg border bg-white">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="text-left text-zinc-500">
            <tr>
              <th className="px-3 py-2 font-medium">Candidate</th>
              <th className="px-3 py-2 font-medium">Role</th>
              <th className="px-3 py-2 font-medium">Tier</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Days in status</th>
              <th className="px-3 py-2 font-medium">Last email</th>
              <th className="px-3 py-2 font-medium">Flags</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-3 py-2">
                  <Link href={`/candidates/${r.id}`} className="hover:underline">
                    {r.name}
                  </Link>
                </td>
                <td className="px-3 py-2">{ROLE_LABEL[r.roleApplied]}</td>
                <td className="px-3 py-2">
                  <TierBadge tier={r.tier} />
                </td>
                <td className="px-3 py-2">{r.pipelineStatus ? PIPELINE_LABEL[r.pipelineStatus] : PROCESSING[status(r)] ?? status(r)}</td>
                <td className="px-3 py-2">{daysSince(r.pipelineStatusAt ?? r.createdAt)}</td>
                <td className="px-3 py-2">{r.lastEmail ? `${r.lastEmail.kind} · ${r.lastEmail.status}` : "—"}</td>
                <td className="px-3 py-2">
                  <FlagBadges flags={r.flags.filter((f) => f === "BOUNCED" || f === "NO_CONTACT" || f === "LEGACY")} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length ? <p className="p-4 text-sm text-zinc-600">No candidates in the pipeline yet.</p> : null}
      </div>
    </section>
  );
}
