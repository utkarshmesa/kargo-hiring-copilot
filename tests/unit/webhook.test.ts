import { createHmac, randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyWebhook } from "@/lib/email/send";
import { POST } from "@/app/api/webhooks/resend/route";

// PRD Step 12: signatures are checked on the raw body with the real Resend verifier.
const secretBytes = randomBytes(24);
const SECRET = `whsec_${secretBytes.toString("base64")}`;

function sign(body: string, id = "msg_1", ts = Math.floor(Date.now() / 1000).toString()) {
  const sig = createHmac("sha256", secretBytes).update(`${id}.${ts}.${body}`).digest("base64");
  return { id, timestamp: ts, signature: `v1,${sig}` };
}

beforeAll(() => {
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
});

describe("webhook signature", () => {
  const body = JSON.stringify({ type: "email.bounced", created_at: new Date().toISOString(), data: { email_id: "re_1" } });

  it("accepts a correctly signed payload", () => {
    expect(verifyWebhook(body, sign(body))).toMatchObject({ type: "email.bounced" });
  });

  it("rejects a tampered body", () => {
    expect(() => verifyWebhook(body.replace("bounced", "delivered"), sign(body))).toThrow();
  });

  it("rejects a signature made with another secret", () => {
    const wrong = createHmac("sha256", randomBytes(24)).update(`msg_1.${Math.floor(Date.now() / 1000)}.${body}`).digest("base64");
    expect(() => verifyWebhook(body, { id: "msg_1", timestamp: `${Math.floor(Date.now() / 1000)}`, signature: `v1,${wrong}` })).toThrow();
  });

  it("the route returns 401 for an unsigned request, before touching the database", async () => {
    const res = await POST(new Request("http://x/api/webhooks/resend", { method: "POST", body }));
    expect(res.status).toBe(401);
  });
});
