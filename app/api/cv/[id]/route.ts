import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db/client";
import { evaluations } from "@/lib/db/schema";
import { downloadFile } from "@/lib/storage";

// "View original CV": streamed through this authenticated route only. The storage URL
// is never sent to the browser. Every view is audited.
const TYPES: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/cv/[id]">) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const database = db();
  const [ev] = await database.select({ filePath: evaluations.filePath }).from(evaluations).where(eq(evaluations.id, id));
  if (!ev?.filePath) return NextResponse.json({ error: "not found" }, { status: 404 });
  const bytes = await downloadFile(ev.filePath);
  await audit(database, "cv.viewed", id);
  const ext = ev.filePath.split(".").pop()!;
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": TYPES[ext] ?? "application/octet-stream",
      "Content-Disposition": `${ext === "pdf" ? "inline" : "attachment"}; filename="cv-${id.slice(0, 8)}.${ext}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
