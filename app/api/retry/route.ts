import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db/client";
import { evaluations } from "@/lib/db/schema";

// US2: a failed CV can be retried from the UI.
const body = z.object({ evaluationId: z.string().uuid() });

export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  const database = db();
  const rows = await database
    .update(evaluations)
    .set({ status: "queued", attempts: 0, transientRetries: 0, nextAttemptAt: null, claimedAt: null, lastError: null })
    .where(and(eq(evaluations.id, parsed.data.evaluationId), eq(evaluations.status, "failed")))
    .returning({ id: evaluations.id });
  if (!rows.length) return NextResponse.json({ error: "only failed CVs can be retried" }, { status: 409 });
  await audit(database, "cv.retry", rows[0].id);
  return NextResponse.json({ ok: true });
}
