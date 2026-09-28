import { beforeAll, describe, expect, it } from "vitest";
import { createSessionToken, passwordMatches, verifySessionToken } from "@/lib/auth/session";

beforeAll(() => {
  process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-characters-long";
});

describe("session", () => {
  it("round-trips a token", async () => {
    expect(await verifySessionToken(await createSessionToken())).toBe(true);
  });

  it("rejects missing, garbage and tampered tokens", async () => {
    expect(await verifySessionToken(undefined)).toBe(false);
    expect(await verifySessionToken("abc")).toBe(false);
    const t = await createSessionToken();
    expect(await verifySessionToken(t.slice(0, -2) + "xx")).toBe(false);
  });

  it("rejects a token signed with another secret", async () => {
    const t = await createSessionToken();
    process.env.SESSION_SECRET = "another-secret-that-is-at-least-32-characters";
    expect(await verifySessionToken(t)).toBe(false);
    process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-characters-long";
  });

  it("compares passwords exactly", () => {
    expect(passwordMatches("pw", "pw")).toBe(true);
    expect(passwordMatches("pw", "pw2")).toBe(false);
    expect(passwordMatches("", undefined)).toBe(false);
  });
});
