import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db/client";
import { pools } from "@/lib/db/schema";
import { currentPool } from "@/lib/pools";

// PRD Step 3: "Close pool" sets closed_at, which starts the retention clock (Step 13).
const body = z.object({ confirm: z.literal("CLOSE") });

export async function POST(request: Request) {
  if (!body.safeParse(await request.json().catch(() => null)).success) {
    return NextResponse.json({ error: 'Type CLOSE to confirm.' }, { status: 400 });
  }
  const database = db();
  const pool = await currentPool(database);
  if (pool.closedAt) return NextResponse.json({ error: "Already closed." }, { status: 409 });
  await database.update(pools).set({ closedAt: new Date() }).where(eq(pools.id, pool.id));
  await audit(database, "pool.closed", pool.id);
  return NextResponse.json({ ok: true });
}
