import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { candidates, evaluations } from "@/lib/db/schema";
import { currentPool } from "@/lib/pools";

// Status list for the upload page (US2). Arjun's own view, so file names are shown.
export async function GET() {
  const database = db();
  const pool = await currentPool(database);
  const rows = await database
    .select({
      id: evaluations.id,
      fileName: candidates.fileName,
      roleApplied: evaluations.roleApplied,
      status: evaluations.status,
      prepared: evaluations.redactedProfileText,
      tier: evaluations.tier,
      tierReason: evaluations.tierReason,
      flags: evaluations.flags,
      lastError: evaluations.lastError,
      createdAt: evaluations.createdAt,
    })
    .from(evaluations)
    .innerJoin(candidates, eq(candidates.id, evaluations.candidateId))
    .where(eq(evaluations.poolId, pool.id))
    .orderBy(desc(evaluations.createdAt));
  return NextResponse.json({
    evaluations: rows.map(({ prepared, ...r }) => ({ ...r, prepared: !!prepared })),
  });
}
