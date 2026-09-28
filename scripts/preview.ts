// Runs Steps 2–5 (parse, guard, Extractor, fidelity, redaction, leak check) on local files
// and prints the redacted profiles. No database. Usage:
//   npx tsx scripts/preview.ts calibration/cv_01_rohan_desai.docx [more files…]
import { config } from "dotenv";
config({ path: ".env.local" });

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseCv } from "../lib/parse";
import { runExtractor } from "../lib/gemini/extractor";
import { checkFidelity } from "../lib/redact/fidelity";
import { buildRedactedProfile } from "../lib/redact/profile";
import { checkLeaks } from "../lib/redact/leak";

async function main() {
  const files = process.argv.slice(2);
  const outDir = process.env.PREVIEW_OUT ?? "";
  if (outDir) await mkdir(outDir, { recursive: true });
  for (const file of files) {
    const bytes = new Uint8Array(await readFile(file));
    const parsed = await parseCv(bytes);
    console.log(`\n===== ${path.basename(file)}: ${parsed.wordCount} words, hidden runs ${parsed.hiddenText.length}, injection lines ${parsed.injectionLines.length}`);
    if (parsed.unparseable) {
      console.log("→ needs_review (unparseable)");
      continue;
    }
    const t0 = Date.now();
    const { data: ex, meta } = await runExtractor(parsed.text);
    const fidelity = checkFidelity(parsed.text, ex);
    const profile = buildRedactedProfile(ex, new Date());
    const leaks = checkLeaks(profile.text, profile.terms);
    console.log(`extractor ${((Date.now() - t0) / 1000).toFixed(1)}s, attempts ${meta.attempts}`);
    console.log(`fidelity ${JSON.stringify(fidelity)}`);
    console.log(`leaks ${JSON.stringify(leaks)}`);
    console.log(`counts ${JSON.stringify(profile.counts)}`);
    if (!fidelity.ok) {
      const { normalizeBullet, normalizeText } = await import("../lib/redact/normalize");
      const hay = normalizeText(parsed.text);
      for (const b of ex.roles.flatMap((r) => r.bullets)) {
        if (!hay.includes(normalizeBullet(b))) console.log(`  MISSING: ${normalizeBullet(b).slice(0, 120)}`);
      }
    }
    if (outDir) await writeFile(path.join(outDir, path.basename(file) + ".txt"), profile.text);
    else console.log(profile.text);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
