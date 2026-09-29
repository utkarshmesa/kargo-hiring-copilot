import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { DecisionError, setStatus } from "@/lib/decisions";

// PRD Step 10: POST /api/status {evaluation_id, status: booked|interviewed|offer|withdrawn}
const body = z.object({ evaluation_id: z.string().uuid(), status: z.enum(["booked", "interviewed", "offer", "withdrawn"]) });

export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  try {
    await setStatus(parsed.data.evaluation_id, parsed.data.status, { db: db() });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof DecisionError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
