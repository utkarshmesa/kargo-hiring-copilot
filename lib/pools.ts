import { defaultConfig, type PoolConfig } from "./config/defaults";
import { parsePoolConfig } from "./config/validate";
import { configHash } from "./hash";
import { rubricHash } from "./rubric";
import type { Db } from "./db/client";
import { pools } from "./db/schema";

export const FIRST_POOL_NAME = "PM/SPM Q4 2026";

export async function createPool(db: Db, name: string, config: PoolConfig = defaultConfig) {
  const valid = parsePoolConfig(config);
  const [row] = await db
    .insert(pools)
    .values({ name, configJson: valid, configHash: configHash(valid), rubricHash: rubricHash() })
    .returning();
  return row;
}
