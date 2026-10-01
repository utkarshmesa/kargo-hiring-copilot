import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";

// Every route needs the session cookie except these. Cron and the Resend webhook
// authenticate themselves (CRON_SECRET / Svix signature) inside their handlers.
// /api/emails/send-due checks its own callers (session, CRON_SECRET or the Vault token).
const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/cron", "/api/webhooks/resend", "/api/emails/send-due"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }
  const ok = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (ok) return NextResponse.next();
  // The daily cron drains the queue by calling process-next once per CV (PRD §8.2).
  const cronSecret = process.env.CRON_SECRET;
  const machinePaths = ["/api/process-next"];
  if (machinePaths.includes(pathname) && cronSecret && request.headers.get("authorization") === `Bearer ${cronSecret}`) {
    return NextResponse.next();
  }
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
