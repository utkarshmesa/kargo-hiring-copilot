import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { sendDueEmails } from "@/lib/email/send";
import { machineAuthorised } from "@/lib/scheduler-token";

// Sends candidate emails whose time has come. Called every 30 s by an open dashboard
// (session cookie), every minute by the Supabase scheduler (Vault token), and by the daily
// cron (CRON_SECRET). Calling it often or concurrently is safe: each email is claimed with
// one conditional UPDATE. It can only send emails that are already due.
export const maxDuration = 60;

async function run(request: NextRequest) {
  const database = db();
  const session = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session && !(await machineAuthorised(database, request.headers.get("authorization")))) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }
  const sent = await sendDueEmails({ db: database, limit: 25 });
  return NextResponse.json({ sent });
}

export const POST = run;
export const GET = run;
