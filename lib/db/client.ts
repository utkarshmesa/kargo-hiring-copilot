import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// Any Drizzle Postgres database with our schema: postgres-js in the app, PGlite in tests.
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

// Supabase transaction pooler (port 6543) does not support prepared statements.
let instance: Db | null = null;

export function db(): Db {
  if (!instance) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    // The local PGlite stand-in (npm run db:local) needs a single connection.
    const max = Number(process.env.DATABASE_MAX_CONNECTIONS ?? 3) || 3;
    const client = postgres(url, { prepare: false, max });
    instance = drizzle(client, { schema }) as unknown as Db;
  }
  return instance;
}
