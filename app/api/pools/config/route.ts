import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { poolConfigSchema } from "@/lib/config/validate";
import type { PoolConfig } from "@/lib/config/defaults";
import { db } from "@/lib/db/client";
import { pools } from "@/lib/db/schema";
import { configHash } from "@/lib/hash";
import { rescorePool } from "@/lib/pipeline/rescore";
import { currentPool } from "@/lib/pools";

// PRD Step 3: Arjun can edit weights and toggles until the pool is locked (its first
// decision). Saving re-scores the pool from stored runs and changes config_hash, which
// closes the calibration gate until `npm run calibrate` passes for the new config.
export async function POST(request: Request) {
  const parsed = poolConfigSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ") }, { status: 400 });
  }
  const database = db();
  const pool = await currentPool(database);
  if (pool.lockedAt) return NextResponse.json({ error: "This pool is locked: its first decision has been made." }, { status: 409 });
  if (pool.closedAt) return NextResponse.json({ error: "This pool is closed." }, { status: 409 });
  const config = parsed.data as PoolConfig;
  const hash = configHash(config);
  if (hash === pool.configHash) return NextResponse.json({ ok: true, unchanged: true });
  await database.update(pools).set({ configJson: config, configHash: hash }).where(eq(pools.id, pool.id));
  const rescored = await rescorePool(database, pool.id, config, hash);
  await audit(database, "config.changed", pool.id);
  return NextResponse.json({ ok: true, rescored, configHash: hash });
}
