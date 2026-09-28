import Link from "next/link";
import { FlagBadges, TierBadge } from "@/components/badges";
import { betterFit, poolRows, rankedTotal, ROLE_LABEL, shortlistSections, type Row } from "@/lib/dashboard";
import { db } from "@/lib/db/client";
import { currentPool } from "@/lib/pools";
import { TIER_REASON_TEXT } from "@/lib/score/labels";

export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function ShortlistPage({ searchParams }: PageProps<"/shortlist">) {
  const sp = await searchParams;
  const role = one(sp.role);
  const tier = one(sp.tier);
  const q = one(sp.q).trim().toLowerCase();

  let rows: Row[];
  try {
    rows = await poolRows(db(), await currentPool(db()));
  } catch {
    return <p className="text-sm text-zinc-600">The database is not connected yet.</p>;
  }
  const filtered = rows.filter(
    (r) =>
      (!role || r.roleApplied === role) &&
      (!tier || r.tier === tier) &&
      (!q || r.name.toLowerCase().includes(q)),
  );
  const s = shortlistSections(filtered);
  const scoredCount = s.A.length + s.B.length + s.C.length + s.D.length + s.R.length;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-xl font-semibold">Shortlist</h1>
        <form className="flex flex-wrap items-end gap-2 text-sm" role="search">
          <label>
            Role
            <select name="role" defaultValue={role} className="ml-1 rounded border px-2 py-1">
              <option value="">All</option>
              <option value="PM">PM</option>
              <option value="SPM">Senior PM</option>
              <option value="NOT_SURE">Not sure</option>
            </select>
          </label>
          <label>
            Tier
            <select name="tier" defaultValue={tier} className="ml-1 rounded border px-2 py-1">
              <option value="">All</option>
              {["A", "B", "C", "D", "R"].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            Name
            <input name="q" defaultValue={q} placeholder="Search" className="ml-1 w-40 rounded border px-2 py-1" />
          </label>
          <button type="submit" className="rounded border bg-white px-3 py-1 hover:bg-zinc-50">
            Apply
          </button>
        </form>
      </div>

      {s.inProgress.length ? (
        <p className="text-sm text-zinc-600">
          {s.inProgress.length} CV(s) still processing or failed. <Link href="/upload" className="underline">See the upload page</Link>.
        </p>
      ) : null}
      {!scoredCount ? <p className="text-sm text-zinc-600">No scored candidates yet.</p> : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <Section title={`Tier A · Shortlist (${s.A.length})`} rows={s.A} className="lg:col-span-2" empty="No Tier A candidates." />
        <Section
          title={`Wildcards (${s.wildcards.length})`}
          note="Strong operator-builders outside logistics. Tier unchanged."
          rows={s.wildcards}
          empty="No wildcards."
        />
      </div>
      <Section title={`Tier B · Consider (${s.B.length})`} rows={s.B} empty="None." />
      <Section title={`Tier C · Hold (${s.C.length})`} rows={s.C} empty="None." />
      <Section
        title={`Please read · Tier R (${s.R.length})`}
        note="No recommendation: the system could not score these reliably. Read the CV and decide."
        rows={s.R}
        empty="None."
        showReason
      />
      <details className="rounded-lg border bg-white p-4">
        <summary className="cursor-pointer font-medium">Tier D · Not a fit for this role ({s.D.length})</summary>
        <div className="mt-3">
          <Rows rows={s.D} empty="None." />
        </div>
      </details>
    </div>
  );
}

function Section(props: { title: string; note?: string; rows: Row[]; empty: string; className?: string; showReason?: boolean }) {
  return (
    <section className={`rounded-lg border bg-white p-4 ${props.className ?? ""}`}>
      <h2 className="font-medium">{props.title}</h2>
      {props.note ? <p className="text-xs text-zinc-600">{props.note}</p> : null}
      <div className="mt-3">
        <Rows rows={props.rows} empty={props.empty} showReason={props.showReason} />
      </div>
    </section>
  );
}

function Rows({ rows, empty, showReason }: { rows: Row[]; empty: string; showReason?: boolean }) {
  if (!rows.length) return <p className="text-sm text-zinc-500">{empty}</p>;
  return (
    <ul className="divide-y">
      {rows.map((r) => {
        const fit = betterFit(r);
        return (
          <li key={r.id} className="py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Link href={`/candidates/${r.id}`} className="font-medium hover:underline">
                {r.name}
              </Link>
              <TierBadge tier={r.tier} />
              {r.pmTotal !== null ? (
                <span className="text-sm text-zinc-700">
                  {rankedTotal(r).toFixed(1)} · core {r.coreScore?.toFixed(1)}
                </span>
              ) : null}
              <span className="text-xs text-zinc-500">
                applied {ROLE_LABEL[r.roleApplied]}
                {r.bestFitRole ? ` · best fit ${ROLE_LABEL[r.bestFitRole]}` : ""}
                {fit ? ` · better fit for ${ROLE_LABEL[fit]}` : ""}
              </span>
              {r.pipelineStatus && r.pipelineStatus !== "scored" ? (
                <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">{r.pipelineStatus}</span>
              ) : null}
            </div>
            {showReason && r.tierReason ? (
              <p className="mt-1 text-sm text-amber-900">
                {r.tierReason
                  .split(", ")
                  .map((k) => TIER_REASON_TEXT[k] ?? k)
                  .join(" ")}
              </p>
            ) : null}
            {r.summary ? <p className="mt-1 text-sm text-zinc-700">{r.summary}</p> : null}
            <div className="mt-1">
              <FlagBadges flags={r.flags} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
