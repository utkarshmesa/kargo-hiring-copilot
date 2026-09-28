import { sql } from "drizzle-orm";

// PRD §8.2: claim one due evaluation in a single statement, with a lease. A row left in
// `processing` by a timed-out function is reclaimed once its lease has expired.
// Must stay above the processing route's maxDuration (300 s) + 60 s.
export const LEASE_SECONDS = 360;

type Executor = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };

/**
 * @param preScoringOnly when the calibration gate is closed, only rows that still need
 *   parsing/extraction/redaction are claimed; nothing is scored.
 */
export async function claimNext(db: Executor, opts: { preScoringOnly: boolean }): Promise<{ id: string } | null> {
  const gate = opts.preScoringOnly ? sql`AND redacted_profile_text IS NULL` : sql``;
  const res = await db.execute(sql`
    UPDATE evaluations
    SET status = 'processing', claimed_at = now(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM evaluations
      WHERE (
        (status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
        OR (status = 'processing' AND claimed_at < now() - make_interval(secs => ${LEASE_SECONDS}))
      ) ${gate}
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id`);
  const rows = Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? []);
  const row = rows[0] as { id: string } | undefined;
  return row ? { id: row.id } : null;
}
