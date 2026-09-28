import { createHash, createHmac } from "node:crypto";

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hmac(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

// Text hashes ignore line endings so a Windows checkout and Vercel agree.
export function sha256Text(text: string): string {
  return sha256(text.replace(/\r\n?/g, "\n"));
}

// JSON with object keys sorted at every level, so equal configs hash equally.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function configHash(config: unknown): string {
  return sha256(canonicalJson(config));
}
