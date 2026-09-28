import { readFileSync } from "node:fs";
import path from "node:path";
import { sha256Text } from "./hash";

// The rubric file is the scoring source of truth. It ships with the deployment
// (see outputFileTracingIncludes in next.config.ts) and is read once per process.
const RUBRIC_PATH = path.join(process.cwd(), "docs", "kargo_hiring_rubric.md");

let cached: { text: string; hash: string } | null = null;

export function rubric(): { text: string; hash: string } {
  if (!cached) {
    const text = readFileSync(RUBRIC_PATH, "utf8").replace(/\r\n?/g, "\n");
    cached = { text, hash: sha256Text(text) };
  }
  return cached;
}

export function rubricHash(): string {
  return rubric().hash;
}

/** Text between a "## N." heading and the next "## " heading. Throws if the rubric changed shape. */
export function rubricSection(n: number): string {
  const text = rubric().text;
  const start = text.search(new RegExp(`^## ${n}\\. `, "m"));
  if (start < 0) throw new Error(`rubric section ${n} not found`);
  const rest = text.slice(start);
  const end = rest.slice(3).search(/^## /m);
  return (end < 0 ? rest : rest.slice(0, end + 3)).trim();
}

/** §6 step 1: the four role types the Scorer classifies (the rest of §6 is code). */
export function roleTypeDefinitions(): string {
  const s6 = rubricSection(6);
  const start = s6.indexOf("1. ");
  const end = s6.indexOf("\n2. ");
  if (start < 0 || end < 0) throw new Error("rubric §6 step 1 not found");
  return s6.slice(start, end).trim();
}

/** Anchor cell text of every §5 table row ("| **4** | … |"), for the anchor-copy check. */
export function anchorTexts(): string[] {
  return rubricSection(5)
    .split("\n")
    .filter((l) => /^\|\s*\*\*\d\*\*\s*\|/.test(l))
    .flatMap((l) => l.split("|").slice(2, -1))
    .map((c) => c.replace(/\*\*/g, "").trim())
    .filter((c) => c.split(/\s+/).length >= 8);
}
