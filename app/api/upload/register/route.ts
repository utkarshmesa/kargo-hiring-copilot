import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db/client";
import { candidates, evaluations } from "@/lib/db/schema";
import { hmac } from "@/lib/hash";
import { currentPool } from "@/lib/pools";
import { fileExists } from "@/lib/storage";

// Step 1 (second half): after the browser's upload succeeds, create the queued evaluation.
// The ticket proves the path was issued by /api/upload/token.
const body = z.object({
  path: z.string().regex(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(docx|pdf)$/),
  ticket: z.string().length(64),
  fileName: z.string().min(1).max(255),
  roleApplied: z.enum(["PM", "SPM", "NOT_SURE"]),
  legacy: z.boolean(),
});

export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  const { path, ticket, fileName, roleApplied, legacy } = parsed.data;

  const expected = hmac(process.env.SESSION_SECRET!, `upload:${path}`);
  if (!timingSafeEqual(Buffer.from(ticket), Buffer.from(expected))) {
    return NextResponse.json({ error: "invalid ticket" }, { status: 403 });
  }
  const database = db();
  const pool = await currentPool(database);
  if (!path.startsWith(`${pool.id}/`)) return NextResponse.json({ error: "wrong pool" }, { status: 409 });
  if (!(await fileExists(path))) return NextResponse.json({ error: "file not uploaded" }, { status: 409 });

  const existing = await database.query.evaluations.findFirst({ where: (e, { eq }) => eq(e.filePath, path) });
  if (existing) return NextResponse.json({ evaluationId: existing.id });

  const [cand] = await database.insert(candidates).values({ poolId: pool.id, fileName, legacy }).returning();
  const [ev] = await database
    .insert(evaluations)
    .values({ candidateId: cand.id, poolId: pool.id, roleApplied, filePath: path, status: "queued" })
    .returning();
  await audit(database, "cv.uploaded", ev.id);
  return NextResponse.json({ evaluationId: ev.id });
}
