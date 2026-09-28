"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PoolConfig } from "@/lib/config/defaults";

// Rubric §15: founder-configurable parameters. Send delays and retention are shown but
// not editable here (they are part of the communication contract, PRD Step 11 / 13).
const WEIGHT_ROWS: { key: "PM" | "SPM" | "CORE"; label: string; dims: string[] }[] = [
  { key: "PM", label: "PM total", dims: ["D1", "D2", "D3", "D4", "D5", "D6", "D7"] },
  { key: "SPM", label: "Senior PM total", dims: ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9"] },
  { key: "CORE", label: "Core Kargo score", dims: ["D1", "D2", "D3", "D4", "D5", "D6"] },
];

export default function SettingsForm({ config, locked, closed }: { config: PoolConfig; locked: boolean; closed: boolean }) {
  const router = useRouter();
  const [c, setC] = useState<PoolConfig>(config);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const setWeight = (role: "PM" | "SPM" | "CORE", dim: string, v: number) =>
    setC((prev) => ({ ...prev, weights: { ...prev.weights, [role]: { ...prev.weights[role], [dim]: v } } }));
  const sum = (role: "PM" | "SPM" | "CORE") => Object.values(c.weights[role]).reduce((a, b) => a + (b ?? 0), 0);

  async function save() {
    if (!confirm("Saving re-scores the whole pool from stored runs and closes the calibration gate until `npm run calibrate` passes for the new config. Continue?")) return;
    setBusy(true);
    const res = await fetch("/api/pools/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c) });
    const body = await res.json();
    setBusy(false);
    setMessage(res.ok ? { ok: true, text: body.unchanged ? "No changes." : `Saved. ${body.rescored} candidate(s) re-scored. Run calibration again.` } : { ok: false, text: body.error });
    router.refresh();
  }

  async function closePool() {
    const typed = prompt('Closing the pool stops uploads and starts the 180-day retention clock. Type CLOSE to confirm.');
    if (typed !== "CLOSE") return;
    const res = await fetch("/api/pools/close", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: typed }) });
    setMessage(res.ok ? { ok: true, text: "Pool closed." } : { ok: false, text: (await res.json()).error });
    router.refresh();
  }

  const num = (v: string) => (v === "" ? 0 : Number(v));

  return (
    <div className="space-y-6">
      <fieldset disabled={locked || busy} className="space-y-6">
        <div className="overflow-x-auto rounded-lg border bg-white p-4">
          <h2 className="font-medium">Weights (each 0–30; each row sums to 100)</h2>
          <table className="mt-2 text-sm">
            <thead>
              <tr>
                <th />
                {["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9"].map((d) => (
                  <th key={d} className="px-1 font-medium">
                    {d}
                  </th>
                ))}
                <th className="px-2 font-medium">Sum</th>
              </tr>
            </thead>
            <tbody>
              {WEIGHT_ROWS.map((row) => (
                <tr key={row.key}>
                  <td className="pr-2">{row.label}</td>
                  {["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9"].map((d) => (
                    <td key={d} className="px-1 py-1">
                      {row.dims.includes(d) ? (
                        <input
                          aria-label={`${row.label} ${d}`}
                          type="number"
                          min={0}
                          max={30}
                          value={c.weights[row.key][d as "D1"] ?? 0}
                          onChange={(e) => setWeight(row.key, d, num(e.target.value))}
                          className="w-14 rounded border px-1 py-0.5"
                        />
                      ) : (
                        <span className="text-zinc-400">—</span>
                      )}
                    </td>
                  ))}
                  <td className={`px-2 ${sum(row.key) === 100 ? "" : "font-semibold text-red-700"}`}>{sum(row.key)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid gap-4 rounded-lg border bg-white p-4 text-sm md:grid-cols-2">
          <h2 className="font-medium md:col-span-2">Tiers and guardrails</h2>
          {(["A", "B", "C"] as const).map((t) => (
            <label key={t} className="flex items-center justify-between gap-2">
              Tier {t} threshold (≥)
              <input type="number" value={c.tiers[t]} onChange={(e) => setC({ ...c, tiers: { ...c.tiers, [t]: num(e.target.value) } })} className="w-20 rounded border px-1 py-0.5" />
            </label>
          ))}
          <label className="flex items-center justify-between gap-2">
            PM experience floor (years; 0 = off)
            <input type="number" step={0.25} min={0} value={c.pmExperienceFloorYears} onChange={(e) => setC({ ...c, pmExperienceFloorYears: num(e.target.value) })} className="w-20 rounded border px-1 py-0.5" />
          </label>
          <label className="flex items-center justify-between gap-2">
            Senior PM experience floor (years; 0 = off)
            <input type="number" step={0.25} min={0} value={c.spmExperienceFloorYears} onChange={(e) => setC({ ...c, spmExperienceFloorYears: num(e.target.value) })} className="w-20 rounded border px-1 py-0.5" />
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.d1GateForTierA} onChange={(e) => setC({ ...c, d1GateForTierA: e.target.checked })} />
            D1 gate for Tier A (require D1 ≥ 2; Wildcards unaffected)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.experienceBandStrict} onChange={(e) => setC({ ...c, experienceBandStrict: e.target.checked })} />
            Strict experience band (out-of-band D7 caps at B)
          </label>
          <label className="flex items-center justify-between gap-2">
            Runs per CV
            <select value={c.runsPerCv} onChange={(e) => setC({ ...c, runsPerCv: Number(e.target.value) as 3 | 5 })} className="rounded border px-1 py-0.5">
              <option value={3}>3</option>
              <option value={5}>5</option>
            </select>
          </label>
          <label className="flex items-center justify-between gap-2">
            Default Hold (days)
            <input type="number" min={1} value={c.holdDefaultDays} onChange={(e) => setC({ ...c, holdDefaultDays: num(e.target.value) })} className="w-20 rounded border px-1 py-0.5" />
          </label>
          <label className="flex items-center justify-between gap-2">
            Offer target date
            <input type="date" value={c.offerTargetDate} onChange={(e) => setC({ ...c, offerTargetDate: e.target.value })} className="rounded border px-1 py-0.5" />
          </label>
          <p className="text-zinc-600 md:col-span-2">
            Fixed: sends Advance +{c.sendDelayMinutes.advance} min, Hold +{c.sendDelayMinutes.hold} min, Decline +{c.sendDelayMinutes.decline / 60} h · one nudge after {c.nudgeAfterDays} days ·
            retention {c.retentionDays} days after the pool closes.
          </p>
        </div>

        <button type="button" onClick={save} className="rounded bg-zinc-900 px-4 py-2 text-white hover:bg-zinc-700 disabled:opacity-50">
          Save and re-score
        </button>
      </fieldset>
      {locked && !closed ? <p className="text-sm text-zinc-600">Config is locked because the first decision in this pool has been made (rubric §3.1).</p> : null}
      {message ? (
        <p role="status" className={`text-sm ${message.ok ? "text-emerald-800" : "text-red-800"}`}>
          {message.text}
        </p>
      ) : null}

      {!closed ? (
        <div className="rounded-lg border border-red-200 bg-white p-4 text-sm">
          <h2 className="font-medium">Close pool</h2>
          <p className="text-zinc-600">Stops new uploads. CV files and identity data are deleted 180 days later; anonymised scores are kept.</p>
          <button type="button" onClick={closePool} className="mt-2 rounded border border-red-400 px-3 py-1.5 text-red-800 hover:bg-red-50">
            Close pool…
          </button>
        </div>
      ) : null}
    </div>
  );
}
