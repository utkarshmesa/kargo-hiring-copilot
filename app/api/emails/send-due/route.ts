import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { sendDueEmails } from "@/lib/email/send";

// Sends candidate emails whose time has come. Called every 30 s by an open dashboard,
// every minute by the Supabase scheduler (Bearer CRON_SECRET), and by the daily cron.
// Calling it often or concurrently is safe: each email is claimed with one conditional UPDATE.
export const maxDuration = 60;

async function run() {
  const sent = await sendDueEmails({ db: db(), limit: 25 });
  return NextResponse.json({ sent });
}

export const POST = run;
export const GET = run;
