// Verifies the private CV bucket: signed browser-style upload, server download, no public access, delete.
import { config } from "dotenv";
config({ path: ".env.local" });
import { randomUUID } from "node:crypto";
import { createUploadUrl, downloadFile, fileExists, removeFiles, ensureBucket } from "../lib/storage";

async function main() {
  await ensureBucket();
  console.log("bucket ok (private)");
  const path = `00000000-0000-0000-0000-000000000000/${randomUUID()}.pdf`;
  const url = await createUploadUrl(path);
  // Same request the browser makes: FormData PUT, no API key.
  const form = new FormData();
  form.append("cacheControl", "3600");
  form.append("", new Blob([new TextEncoder().encode("%PDF-1.4 storage check")]), "x.pdf");
  const put = await fetch(url, { method: "PUT", body: form, headers: { "x-upsert": "false" } });
  console.log("signed PUT status", put.status);
  console.log("exists", await fileExists(path));
  const back = new TextDecoder().decode(await downloadFile(path));
  console.log("round trip", back === "%PDF-1.4 storage check");
  const pub = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/public/cvs/${path}`);
  console.log("public URL status (must not be 200)", pub.status);
  await removeFiles([path]);
  console.log("exists after delete", await fileExists(path));
}
main().catch((e) => { console.error(e.message); process.exit(1); });
