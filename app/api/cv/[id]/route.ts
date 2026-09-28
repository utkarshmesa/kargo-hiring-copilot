import { eq } from "drizzle-orm";
import mammoth from "mammoth";
import { NextResponse, type NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db/client";
import { evaluations } from "@/lib/db/schema";
import { downloadFile } from "@/lib/storage";

// "View original CV": streamed through this authenticated route only; the storage URL is
// never sent to the browser. Every view is audited. ?view=1 renders a DOCX as HTML (with
// mammoth) so Arjun can read it in the browser; PDFs open inline.
const TYPES: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

// The CV is untrusted: the rendered page may not run scripts or load anything external.
const VIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

export async function GET(req: NextRequest, ctx: RouteContext<"/api/cv/[id]">) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const database = db();
  const [ev] = await database.select({ filePath: evaluations.filePath }).from(evaluations).where(eq(evaluations.id, id));
  if (!ev?.filePath) return NextResponse.json({ error: "not found" }, { status: 404 });
  const bytes = Buffer.from(await downloadFile(ev.filePath));
  await audit(database, "cv.viewed", id);
  const ext = ev.filePath.split(".").pop()!;
  const common = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

  if (ext === "docx" && req.nextUrl.searchParams.get("view")) {
    const { value } = await mammoth.convertToHtml({ buffer: bytes });
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>CV</title><style>body{font-family:system-ui,sans-serif;max-width:800px;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#18181b}table{border-collapse:collapse}td{padding:2px 6px;vertical-align:top}</style></head><body>${value}</body></html>`;
    return new Response(html, { headers: { ...common, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": VIEW_CSP } });
  }
  return new Response(bytes, {
    headers: {
      ...common,
      "Content-Type": TYPES[ext] ?? "application/octet-stream",
      "Content-Disposition": `${ext === "pdf" ? "inline" : "attachment"}; filename="cv-${id.slice(0, 8)}.${ext}"`,
      ...(ext === "pdf" ? {} : { "Content-Security-Policy": VIEW_CSP }),
    },
  });
}
