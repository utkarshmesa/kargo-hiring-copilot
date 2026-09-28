// The go-live gate (PRD §10, rubric §14.1). Runs the 8 past hires through the full
// pipeline (Steps 2–8), blind: labels never reach a model. PASS when every "Exceeds"
// hire's core score is higher than every "Meets"/"Below" hire's.
//
// Writes the result to `calibrations` when DATABASE_URL is set. A failing run is
// reported with dimension-level differences; weights and anchors are never changed here.
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { defaultConfig, type PoolConfig } from "../lib/config/defaults";
import { modelId, GEMINI_TEMPERATURE, GEMINI_SEED } from "../lib/gemini/client";
import { configHash } from "../lib/hash";
import { rubricHash } from "../lib/rubric";
import { runLive } from "./live";

type Hire = { file: string; label: "Exceeds" | "Meets" | "Below"; joined: string; reference: Record<string, number> };
const DIMS = ["D1", "D2", "D3", "D4", "D5", "D6"] as const;

async function poolConfigOrDefault(): Promise<{ config: PoolConfig; source: string }> {
  if (!process.env.DATABASE_URL) return { config: defaultConfig, source: "config.ts defaults (no DATABASE_URL)" };
  const { db } = await import("../lib/db/client");
  const { currentPool, poolConfig } = await import("../lib/pools");
  const pool = await currentPool(db());
  return { config: poolConfig(pool), source: `pool "${pool.name}"` };
}

async function main() {
  const { hires } = JSON.parse(await readFile("calibration/labels.json", "utf8")) as { hires: Hire[] };
  const { config, source } = await poolConfigOrDefault();
  const model = modelId();
  console.log(`Calibration · model ${model} · temperature ${GEMINI_TEMPERATURE} · seed ${GEMINI_SEED} · config from ${source}`);
  console.log(`rubric_hash ${rubricHash().slice(0, 12)}… · config_hash ${configHash(config).slice(0, 12)}…\n`);

  const rows: {
    id: string;
    label: string;
    ref: Record<string, number>;
    got: Record<string, number> | null;
    runs: Record<string, number[]>;
    core: number | null;
    tier: string | null;
    note: string;
  }[] = [];

  for (const [i, h] of hires.entries()) {
    const id = `cv_${String(i + 1).padStart(2, "0")}`;
    process.stdout.write(`${id} (${h.label}) … `);
    const t0 = Date.now();
    const bytes = new Uint8Array(await readFile(path.join("calibration", h.file)));
    const r = await runLive(bytes, new Date(`${h.joined}T00:00:00Z`), "NOT_SURE", config, id);
    if (!r.ok) {
      console.log(`needs_review (${r.prepared.kind})`);
      rows.push({ id, label: h.label, ref: h.reference, got: null, runs: {}, core: null, tier: "R", note: r.prepared.kind });
      continue;
    }
    const got = Object.fromEntries(DIMS.map((d) => [d, r.rank.dims[d].score]));
    const runs = Object.fromEntries(DIMS.map((d) => [d, r.rank.dims[d].runScores]));
    const notes = [
      r.rank.tierReason ?? "",
      DIMS.filter((d) => r.rank.dims[d].quoteMismatch).map((d) => `${d} quote mismatch`).join(", "),
      r.briefOk ? "" : "brief failed",
    ].filter(Boolean);
    rows.push({ id, label: h.label, ref: h.reference, got, runs, core: r.rank.coreScore, tier: r.rank.tier, note: notes.join("; ") });
    console.log(`core ${r.rank.coreScore.toFixed(1)} · tier ${r.rank.tier} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  // ---- table next to rubric Appendix A ----
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  console.log(`\n${pad("CV", 7)}${pad("Rating", 9)}${DIMS.map((d) => pad(d, 8)).join("")}${pad("Core", 14)}Tier`);
  console.log(`${pad("", 16)}${DIMS.map(() => pad("got/ref", 8)).join("")}${pad("got / ref", 14)}`);
  for (const r of rows) {
    const cells = DIMS.map((d) => pad(r.got ? `${r.got[d]}/${r.ref[d]}` : `-/${r.ref[d]}`, 8)).join("");
    const core = r.core === null ? "—" : r.core.toFixed(1);
    console.log(`${pad(r.id, 7)}${pad(r.label, 9)}${cells}${pad(`${core} / ${r.ref.core.toFixed(1)}`, 14)}${r.tier ?? ""}${r.note ? `  (${r.note})` : ""}`);
  }

  const exceeds = rows.filter((r) => r.label === "Exceeds");
  const others = rows.filter((r) => r.label !== "Exceeds");
  const complete = rows.every((r) => r.core !== null);
  const minExceeds = Math.min(...exceeds.map((r) => r.core ?? -Infinity));
  const maxOthers = Math.max(...others.map((r) => r.core ?? Infinity));
  const passed = complete && minExceeds > maxOthers;
  console.log(
    `\nLowest Exceeds core ${minExceeds.toFixed(1)} vs highest Meets/Below core ${maxOthers.toFixed(1)} → margin ${(minExceeds - maxOthers).toFixed(1)} (reference: 80.0 vs 50.0, margin 30.0)`,
  );
  console.log(passed ? "\nRESULT: PASS" : "\nRESULT: FAIL");

  const diffs = rows.flatMap((r) =>
    r.got ? DIMS.filter((d) => r.got![d] !== r.ref[d]).map((d) => `${r.id} ${r.label} ${d}: got ${r.got![d]} (runs ${r.runs[d].join(",")}) vs reference ${r.ref[d]}`) : [],
  );
  if (diffs.length) console.log(`\nDimension-level differences from Appendix A (${diffs.length}):\n  ${diffs.join("\n  ")}`);
  if (!passed) console.log("\nWeights and anchors were NOT changed. Review the differences with Arjun before changing anything.");

  const results = { passed, minExceeds, maxOthers, rows, model, temperature: GEMINI_TEMPERATURE, seed: GEMINI_SEED };
  await mkdir("calibration/results", { recursive: true });
  const file = `calibration/results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(file, JSON.stringify(results, null, 2));
  console.log(`\nSaved ${file}`);

  if (process.env.DATABASE_URL) {
    const { db } = await import("../lib/db/client");
    const { calibrations } = await import("../lib/db/schema");
    await db().insert(calibrations).values({ rubricHash: rubricHash(), configHash: configHash(config), modelId: model, passed, resultsJson: results });
    console.log(passed ? "Recorded in `calibrations`: the gate is now open for these hashes." : "Recorded in `calibrations` as a failed run.");
  } else {
    console.log("DATABASE_URL not set: result not recorded, so the scoring gate stays closed.");
  }
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
