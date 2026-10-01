import { beforeEach, describe, expect, it } from "vitest";
import { machineAuthorised, resetSchedulerTokenCache } from "@/lib/scheduler-token";

// The scheduler authenticates with CRON_SECRET or a token kept in Supabase Vault.
function fakeDb(vaultValue: string | null | "throws") {
  return {
    execute: async () => {
      if (vaultValue === "throws") throw new Error('schema "vault" does not exist');
      return vaultValue ? [{ decrypted_secret: vaultValue }] : [];
    },
  } as never;
}

beforeEach(() => {
  resetSchedulerTokenCache();
  process.env.CRON_SECRET = "cron-secret-0123456789abcdef";
});

describe("machineAuthorised", () => {
  it("accepts CRON_SECRET", async () => {
    expect(await machineAuthorised(fakeDb(null), "Bearer cron-secret-0123456789abcdef")).toBe(true);
  });

  it("accepts the Vault scheduler token", async () => {
    expect(await machineAuthorised(fakeDb("vault-token-abcdefghijklmnop"), "Bearer vault-token-abcdefghijklmnop")).toBe(true);
  });

  it.each([
    ["no header", null],
    ["wrong token", "Bearer wrong-token-abcdefghijklmnop"],
    ["no Bearer prefix", "cron-secret-0123456789abcdef"],
    ["empty token", "Bearer "],
  ])("rejects %s", async (_, header) => {
    expect(await machineAuthorised(fakeDb("vault-token-abcdefghijklmnop"), header)).toBe(false);
  });

  it("rejects everything but CRON_SECRET when there is no Vault (local database)", async () => {
    expect(await machineAuthorised(fakeDb("throws"), "Bearer vault-token-abcdefghijklmnop")).toBe(false);
  });
});
