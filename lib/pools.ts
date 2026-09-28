import { and, desc, eq, isNull } from "drizzle-orm";
import { defaultConfig, type PoolConfig } from "./config/defaults";
import { parsePoolConfig } from "./config/validate";
import { configHash } from "./hash";
import { rubricHash } from "./rubric";
import type { Db } from "./db/client";
import { calibrations, pools } from "./db/schema";

export const FIRST_POOL_NAME = "PM/SPM Q4 2026";

export type Pool = typeof pools.$inferSelect;

export async function createPool(db: Db, name: string, config: PoolConfig = defaultConfig) {
  const valid = parsePoolConfig(config);
  const [row] = await db
    .insert(pools)
    .values({ name, configJson: valid, configHash: configHash(valid), rubricHash: rubricHash() })
    .returning();
  return row;
}

/** The newest open pool; the app starts with one, created on first use. */
export async function currentPool(db: Db): Promise<Pool> {
  const [open] = await db.select().from(pools).where(isNull(pools.closedAt)).orderBy(desc(pools.createdAt)).limit(1);
  return open ?? createPool(db, FIRST_POOL_NAME);
}

export function poolConfig(pool: Pool): PoolConfig {
  return parsePoolConfig(pool.configJson);
}

// PRD §8.2 / §10: live CVs are not scored until a passing calibration exists for the
// current rubric hash, this pool's config hash and the model ID.
export async function calibrationPassed(db: Db, pool: Pool, model: string): Promise<boolean> {
  const [row] = await db
    .select({ id: calibrations.id })
    .from(calibrations)
    .where(
      and(
        eq(calibrations.rubricHash, rubricHash()),
        eq(calibrations.configHash, pool.configHash),
        eq(calibrations.modelId, model),
        eq(calibrations.passed, true),
      ),
    )
    .limit(1);
  return !!row;
}
