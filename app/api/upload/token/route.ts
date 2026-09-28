import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { hmac } from "@/lib/hash";
import { currentPool } from "@/lib/pools";
import { ALLOWED_EXTENSIONS, MAX_FILE_BYTES, createUploadUrl } from "@/lib/storage";

// Step 1: hands the browser a one-time signed URL to upload one CV straight to private
// storage. The file never passes through a function body.
const body = z.object({ fileName: z.string().min(1).max(255), size: z.number().int().positive() });

export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  const { fileName, size } = parsed.data;
  const ext = fileName.toLowerCase().slice(fileName.lastIndexOf("."));
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
    return NextResponse.json({ error: "Only .docx and .pdf files are supported" }, { status: 415 });
  }
  if (size > MAX_FILE_BYTES) return NextResponse.json({ error: "File is larger than 10 MB" }, { status: 413 });

  const pool = await currentPool(db());
  if (pool.closedAt) return NextResponse.json({ error: "This pool is closed; no new uploads." }, { status: 409 });
  // Random path: nothing about the candidate is in it.
  const path = `${pool.id}/${randomUUID()}${ext}`;
  const signedUrl = await createUploadUrl(path);
  const ticket = hmac(process.env.SESSION_SECRET!, `upload:${path}`);
  return NextResponse.json({ signedUrl, path, ticket });
}
