import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { verifyWebhook } from "@/lib/email/send";
import { applyEmailEvent } from "@/lib/email/events";

// PRD Step 12: Resend delivery events. The Svix signature is verified on the raw body;
// anything unsigned or tampered with is rejected before it touches the database.
export async function POST(request: Request) {
  const raw = await request.text();
  const headers = {
    id: request.headers.get("svix-id") ?? "",
    timestamp: request.headers.get("svix-timestamp") ?? "",
    signature: request.headers.get("svix-signature") ?? "",
  };
  let event: { type: string; data?: { email_id?: string } };
  try {
    event = verifyWebhook(raw, headers) as typeof event;
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }
  await applyEmailEvent(db(), event.type, event.data?.email_id);
  return NextResponse.json({ ok: true });
}
