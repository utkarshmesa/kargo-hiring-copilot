// Rubric §14.2 / PRD §10: the B1–B12 synthetic CVs through live Gemini. Each must land
// within one tier of its expected tier (R must be exactly R) with the expected flags.
// Run manually before go-live and after any model or rubric change.
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { defaultConfig } from "../lib/config/defaults";
import { modelId } from "../lib/gemini/client";
import { AS_OF, B_CASES, cvLines } from "../tests/fixtures/bcases";
import { makeDocx } from "../tests/fixtures/build";
import { runLive } from "./live";

const ORDER = ["A", "B", "C", "D"];
function tierOk(expected: string, got: string): boolean {
  if (expected === "R" || got === "R") return expected === got;
  return Math.abs(ORDER.indexOf(expected) - ORDER.indexOf(got)) <= 1;
}

async function main() {
  const only = process.argv.slice(2);
  const cases = only.length ? B_CASES.filter((c) => only.includes(c.id)) : B_CASES;
  console.log(`Regression · model ${modelId()} · ${cases.length} cases\n`);
  let failures = 0;
  for (const c of cases) {
    const lines = cvLines(c.extractor);
    const hidden = (c.hiddenLines ?? []).map((text) => [{ text, color: "FFFFFF" }]);
    const bytes = await makeDocx([...lines.slice(0, 3), ...hidden, ...lines.slice(3)]);
    const r = await runLive(bytes, AS_OF, c.roleApplied, defaultConfig, c.id);
    const tier = r.ok ? r.rank.tier : "R";
    const flags = r.ok ? r.rank.flags : [];
    const missing = (c.expect.flags ?? []).filter((f) => !flags.includes(f));
    const unwanted = (c.expect.notFlags ?? []).filter((f) => flags.includes(f));
    const tierPass = tierOk(c.expect.tier, tier) || (c.expect.alsoAcceptable ?? []).includes(tier as never);
    const ok = tierPass && !missing.length && !unwanted.length;
    if (!ok) failures++;
    const total = r.ok ? (r.rank.roleUsed === "PM" ? r.rank.pmTotal : r.rank.spmTotal).toFixed(1) : "—";
    const dims = r.ok ? ["D1", "D2", "D3", "D4", "D5", "D6", "D8", "D9"].map((d) => `${d}=${r.rank.dims[d as "D1"].score}`).join(" ") : `(${r.prepared.kind})`;
    console.log(
      `${ok ? "PASS" : "FAIL"} ${c.id.padEnd(4)} expected ${c.expect.tier}${c.expect.total ? ` ≈${c.expect.total}` : ""} · got ${tier} ${total} · ${dims}` +
        `${missing.length ? ` · missing ${missing.join(",")}` : ""}${unwanted.length ? ` · unexpected ${unwanted.join(",")}` : ""}` +
        `${r.ok && r.rank.tierReason ? ` · ${r.rank.tierReason}` : ""}`,
    );
  }
  console.log(`\n${cases.length - failures}/${cases.length} passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
