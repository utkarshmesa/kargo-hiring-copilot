// Creates the first pool if the database has none. Safe to run repeatedly.
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { db } = await import("../lib/db/client");
  const { pools } = await import("../lib/db/schema");
  const { createPool, FIRST_POOL_NAME } = await import("../lib/pools");
  const existing = await db().select({ id: pools.id }).from(pools).limit(1);
  if (existing.length) {
    console.log("A pool already exists; nothing to do.");
  } else {
    const pool = await createPool(db(), FIRST_POOL_NAME);
    console.log(`Created pool "${pool.name}" (${pool.id}), config_hash ${pool.configHash.slice(0, 12)}…`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
