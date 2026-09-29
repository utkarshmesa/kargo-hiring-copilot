import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { applyRetention, drainQueue, reconcileEmails, sendDailyDigest, sendNudges } from "@/lib/cron";
import { db } from "@/lib/db/client";
import { log } from "@/lib/log";

// PRD Step 13. Vercel Cron calls this with GET and `Authorization: Bearer $CRON_SECRET`;
// anything else is rejected. Each job runs even if an earlier one fails.
export const maxDuration = 300;

function authorised(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  if (!authorised(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const deps = { db: db() };
  const result: Record<string, unknown> = {};
  const run = async (name: string, job: () => Promise<unknown>) => {
    try {
      result[name] = await job();
    } catch (err) {
      result[name] = { error: err instanceof Error ? err.name : "error" };
      log("cron.job_failed", { job: name });
    }
  };
  await run("emails", () => reconcileEmails(deps));
  await run("nudges", () => sendNudges(deps));
  await run("digest", () => sendDailyDigest(deps));
  await run("retention", () => applyRetention(deps));
  // Last, with the remaining time: one process-next call per CV.
  await run("drain", () =>
    drainQueue({
      appUrl: process.env.APP_URL ?? new URL(request.url).origin,
      cronSecret: process.env.CRON_SECRET!,
      budgetMs: 200_000,
      concurrency: Math.max(1, Math.min(4, Number(process.env.GEMINI_CONCURRENCY ?? 2) || 2)),
    }),
  );
  log("cron.done", { nudges: Number(result.nudges) || 0 });
  return NextResponse.json(result);
}
