import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// CV files live in a private Supabase Storage bucket. The browser uploads straight to a
// signed URL (never through a function body); files are read back only by server code
// and streamed to Arjun through the authenticated GET /api/cv/:id route.
export const BUCKET = "cvs";
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_EXTENSIONS = [".docx", ".pdf"] as const;

let client: SupabaseClient | null = null;
function storage() {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
    client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return client.storage;
}

let bucketReady = false;
export async function ensureBucket() {
  if (bucketReady) return;
  const { data } = await storage().getBucket(BUCKET);
  if (!data) {
    const { error } = await storage().createBucket(BUCKET, { public: false, fileSizeLimit: MAX_FILE_BYTES });
    if (error && !/already exists/i.test(error.message)) throw new Error(`createBucket failed: ${error.message}`);
  } else if (data.public) {
    throw new Error(`Storage bucket "${BUCKET}" is public; it must be private`);
  }
  bucketReady = true;
}

export async function createUploadUrl(path: string): Promise<string> {
  await ensureBucket();
  const { data, error } = await storage().from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new Error(`createSignedUploadUrl failed: ${error?.message}`);
  return data.signedUrl;
}

export async function fileExists(path: string): Promise<boolean> {
  const { data } = await storage().from(BUCKET).exists(path);
  return data === true;
}

export async function downloadFile(path: string): Promise<Uint8Array> {
  const { data, error } = await storage().from(BUCKET).download(path);
  if (error || !data) throw new Error(`download failed: ${error?.message}`);
  return new Uint8Array(await data.arrayBuffer());
}

export async function removeFiles(paths: string[]): Promise<void> {
  if (!paths.length) return;
  const { error } = await storage().from(BUCKET).remove(paths);
  if (error) throw new Error(`remove failed: ${error.message}`);
}
