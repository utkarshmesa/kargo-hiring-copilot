import type { Db } from "./db/client";
import { auditLog } from "./db/schema";

// PRD §8.3: CV views, decisions, undos and config changes are recorded.
export async function audit(db: Db, action: string, targetId: string | null, actor = "arjun") {
  await db.insert(auditLog).values({ actor, action, targetId });
}
