import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "./db/client";
import { log } from "./log";

// The Supabase scheduler (pg_cron, docs/supabase-scheduler.sql) authenticates with a random
// token that Supabase generated itself and keeps in its encrypted Vault. The app reads it
// back over its own database connection, so the value never has to be copied anywhere.
const SECRET_NAME = "kargo_scheduler_token";
const CACHE_MS = 5 * 60_000;
let cached: { value: string | null; at: number } | null = null;

async function vaultToken(db: Db): Promise<string | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  let value: string | null = null;
  try {
    const res = (await db.execute(sql`select decrypted_secret from vault.decrypted_secrets where name = ${SECRET_NAME} limit 1`)) as unknown;
    const rows = Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? []);
    value = ((rows[0] as { decrypted_secret?: string } | undefined)?.decrypted_secret ?? null) || null;
  } catch (err) {
    value = null; // no Vault (the local stand-in database) or the database is unreachable
    log("scheduler.vault_unavailable", { error: err instanceof Error ? err.name : "unknown", code: (err as { code?: string })?.code });
  }
  cached = { value, at: Date.now() };
  return value;
}

export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** True if `Authorization: Bearer <token>` matches CRON_SECRET or the Vault scheduler token. */
export async function machineAuthorised(db: Db, authorization: string | null): Promise<boolean> {
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (token.length < 16) return false;
  const cron = process.env.CRON_SECRET;
  if (cron && sameSecret(token, cron)) return true;
  const vault = await vaultToken(db);
  return !!vault && sameSecret(token, vault);
}

export function resetSchedulerTokenCache() {
  cached = null;
}
