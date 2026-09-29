import { eq, sql } from "drizzle-orm";
import { audit } from "@/lib/audit";
import type { Db } from "@/lib/db/client";
import { emails, evaluations } from "@/lib/db/schema";

// Webhook events → email status. Statuses only move forward, so a late or repeated event
// can't undo a newer one. A bounce flags the candidate (red on the dashboard).
const RANK: Record<string, number> = { pending: 0, scheduled: 1, sent: 2, delivered: 3, bounced: 4, failed: 4, cancelled: 4 };
const STATUS_FOR: Record<string, "sent" | "delivered" | "bounced" | "failed"> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.failed": "failed",
};

export async function applyEmailEvent(db: Db, type: string, resendId: string | undefined) {
  if (!resendId) return;
  const [email] = await db.select().from(emails).where(eq(emails.resendId, resendId));
  if (!email) return; // not ours (or already deleted by retention)
  if (type === "email.complained") {
    await audit(db, "email.complained", email.id, "resend");
    return;
  }
  const next = STATUS_FOR[type];
  if (!next || RANK[next] <= RANK[email.status]) return;
  await db.update(emails).set({ status: next }).where(eq(emails.id, email.id));
  if (next === "bounced" && email.evaluationId) {
    await db
      .update(evaluations)
      .set({ flags: sql`array(select distinct unnest(${evaluations.flags} || ARRAY['BOUNCED']::text[]))` })
      .where(eq(evaluations.id, email.evaluationId));
  }
}
