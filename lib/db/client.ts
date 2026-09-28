import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// Supabase transaction pooler (port 6543) does not support prepared statements.
let instance: ReturnType<typeof create> | null = null;

function create() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = postgres(url, { prepare: false, max: 3 });
  return drizzle(client, { schema });
}

export function db() {
  if (!instance) instance = create();
  return instance;
}

export type Db = ReturnType<typeof db>;
