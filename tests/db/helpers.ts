import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/lib/db/schema";

// In-memory Postgres with the real migrations applied. Migrations run once per test file;
// each test then gets a fresh clone, which is fast and fully isolated.
let template: Promise<PGlite> | null = null;

async function migrated(): Promise<PGlite> {
  const pg = new PGlite();
  await migrate(drizzle(pg, { schema }), { migrationsFolder: "drizzle" });
  return pg;
}

export async function testDb() {
  template ??= migrated();
  const client = (await (await template).clone()) as PGlite;
  const db = drizzle(client, { schema });
  return { db, client };
}
