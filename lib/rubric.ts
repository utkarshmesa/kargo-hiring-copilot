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
