// Runs real CV files through the full pipeline (Steps 2–8) with live Gemini and no
// database, and prints a review of each: parse, redaction/leaks, scores, tier, flags, brief.
//   npm run try -- [--role PM|SPM|NOT_SURE] file1.pdf file2.docx …
// Without --role, a file name starting with "spm" is treated as SPM, otherwise PM.
import { config } from "dotenv";
config({ path: ".env.local" });

import { readFile } from "node:fs/promises";
import path from "node:path";
import { defaultConfig } from "../lib/config/defaults";
import { runWriter } from "../lib/gemini/writer";
import { checkLeaks } from "../lib/redact/leak";
import { writerEvidence } from "../lib/pipeline/score";
import type { RoleApplied } from "../lib/score/rank";
import { runLive, withRetry } from "./live";

async function main() {
  const args = process.argv.slice(2);
  const roleIdx = args.indexOf("--role");
  const forced = roleIdx >= 0 ? (args.splice(roleIdx, 2)[1] as RoleApplied) : null;
  for (const file of args) {
    const name = path.basename(file);
    const role: RoleApplied = forced ?? (/^spm/i.test(name) ? "SPM" : "PM");
    const t0 = Date.now();
    const bytes = new Uint8Array(await readFile(file));
    const r = await runLive(bytes, new Date(), role, defaultConfig, name);
    console.log(`\n================ ${name} (applied ${role}) · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    const p = r.prepared;
    console.log(`parse: ${p.parsed.wordCount} words · hidden runs ${p.parsed.hiddenText.length} · injection lines ${p.parsed.injectionLines.length}`);
    if (!r.ok) {
      console.log(`→ needs_review (tier R): ${p.kind}`, "fidelity" in p ? JSON.stringify(p.fidelity) : "", "leaks" in p ? JSON.stringify(p.leaks) : "");
      continue;
    }
    console.log(`fidelity: ${JSON.stringify(r.prepared.fidelity)} · leaks: ${JSON.stringify(checkLeaks(r.prepared.profile.text, r.prepared.profile.terms))}`);
    console.log(`redactions: ${JSON.stringify(r.prepared.profile.counts)}`);
    const k = r.rank;
    console.log(`experience: ${k.experience.pmRelevantYears} PM-relevant years · ${k.experience.roles.map((x) => `R${x.roleIndex} ${x.type} ${x.months ?? "?"}m`).join(", ")}`);
    console.log(`D7: PM ${k.d7.PM} · SPM ${k.d7.SPM} · qualifiers ${JSON.stringify(k.qualifiers)}`);
    for (const d of Object.values(k.dims)) {
      console.log(`  ${d.id} ${d.score}/4 runs ${d.runScores.join("/")} ${d.evidence_status}/${d.confidence}${d.quoteMismatch ? " QUOTE_MISMATCH" : ""}${d.capped ? " capped" : ""}${d.reuseNote ? " reuse" : ""} · "${(d.evidence[0]?.quote ?? "").slice(0, 90)}"`);
    }
    console.log(`TOTALS: PM ${k.pmTotal.toFixed(1)} · SPM ${k.spmTotal.toFixed(1)} · core ${k.coreScore.toFixed(1)} · best fit ${k.bestFitRole}`);
    console.log(`TIER ${k.tier}${k.tierReason ? ` (${k.tierReason})` : ""} · flags ${k.flags.join(", ") || "none"}`);
    const brief = await withRetry(() => runWriter(writerEvidence(k, defaultConfig)), `${name} writer`).catch(() => null);
    if (brief) {
      console.log(`why: ${brief.why_ranked_here}`);
      console.log(`probes: ${brief.interview_probes.map((x, i) => `\n   ${i + 1}. ${x}`).join("")}`);
      console.log(`invite line: ${brief.invite_line}${brief.removed.length ? ` · removed ${brief.removed.join(",")}` : ""}`);
    } else console.log("brief: unavailable");
    console.log("--- redacted profile (what the AI saw) ---\n" + r.prepared.profile.text);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
