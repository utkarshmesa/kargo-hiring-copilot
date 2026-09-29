import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { DecisionError, decide } from "@/lib/decisions";

// PRD Step 10: POST /api/decide {evaluation_id, action, reason?, hold_until?, invite_line_override?}
const body = z.object({
  evaluation_id: z.string().uuid(),
  action: z.enum(["advance", "decline", "hold"]),
  reason: z.string().max(500).nullish(),
  hold_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  invite_line_override: z.string().max(300).nullish(),
  role_title: z.enum(["PM", "SPM"]).nullish(),
});

export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  const p = parsed.data;
  try {
    const { decision, email } = await decide(
      {
        evaluationId: p.evaluation_id,
        action: p.action,
        reason: p.reason,
        holdUntil: p.hold_until,
        inviteLineOverride: p.invite_line_override,
        roleTitle: p.role_title,
      },
      { db: db() },
    );
    return NextResponse.json({ decisionId: decision.id, email: email.ok ? { scheduledAt: email.scheduledAt } : { skipped: email.reason } });
  } catch (err) {
    if (err instanceof DecisionError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
