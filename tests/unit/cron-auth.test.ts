import { beforeAll, describe, expect, it } from "vitest";
import { GET } from "@/app/api/cron/route";

// PRD Step 13: the cron route only answers Vercel's `Authorization: Bearer $CRON_SECRET`.
beforeAll(() => {
  process.env.CRON_SECRET = "test-cron-secret-0123456789";
});

describe("cron auth", () => {
  it.each([
    ["no header", undefined],
    ["wrong secret", "Bearer nope"],
    ["missing Bearer prefix", "test-cron-secret-0123456789"],
  ])("rejects %s", async (_, header) => {
    const res = await GET(new Request("http://x/api/cron", { headers: header ? { authorization: header } : {} }));
    expect(res.status).toBe(401);
  });
});
