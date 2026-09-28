import { describe, expect, it } from "vitest";
import { canonicalJson, configHash, hmac, sha256Text } from "@/lib/hash";
import { defaultConfig } from "@/lib/config/defaults";
import { rubric } from "@/lib/rubric";

describe("hashes", () => {
  it("text hash ignores CRLF vs LF", () => {
    expect(sha256Text("a\r\nb\r\n")).toBe(sha256Text("a\nb\n"));
  });

  it("config hash ignores key order", () => {
    expect(configHash({ b: 1, a: { d: 2, c: 3 } })).toBe(configHash({ a: { c: 3, d: 2 }, b: 1 }));
    expect(canonicalJson({ b: [2, 1], a: null })).toBe('{"a":null,"b":[2,1]}');
  });

  it("config hash changes when a weight changes", () => {
    const c = structuredClone(defaultConfig);
    c.weights.PM.D1 = 19;
    expect(configHash(c)).not.toBe(configHash(defaultConfig));
  });

  it("rubric loads and hashes to a stable value", () => {
    const r = rubric();
    expect(r.text).toContain("## 5. Scoring dimensions");
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.hash).toBe(sha256Text(r.text));
  });

  it("hmac depends on the secret", () => {
    expect(hmac("s1", "x@y.com")).not.toBe(hmac("s2", "x@y.com"));
  });
});
