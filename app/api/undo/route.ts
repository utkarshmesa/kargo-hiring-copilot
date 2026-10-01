import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { undo } from "@/lib/decisions";

// US6 / PRD Step 11: POST /api/undo {decision_id} → Resend cancel → decision undone.
const body = z.object({ decision_id: z.string().uuid() });

const MESSAGE: Record<string, string> = {
  already_sent: "Already sent: it can no longer be undone.",
  too_late: "Too late to undo.",
  not_found: "Nothing to undo.",
};

export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  const r = await undo(parsed.data.decision_id, { db: db() });
  if (r.ok) return NextResponse.json({ ok: true });
  return NextResponse.json({ error: MESSAGE[r.reason], reason: r.reason }, { status: 409 });
}
