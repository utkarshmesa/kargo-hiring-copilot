import { config as loadEnv } from "dotenv";
import { defineConfig } from "@playwright/test";

loadEnv({ path: ".env.local" });

// End-to-end: the real app (dev server + local stand-in DB), real Gemini and Resend.
// Every email the test schedules is undone again before it can send.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 10 * 60_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:3000", channel: "msedge", headless: true, trace: "retain-on-failure" },
  webServer: [
    { command: "npm run db:local", port: 54329, reuseExistingServer: true, timeout: 120_000 },
    { command: "npm run dev", url: "http://localhost:3000/login", reuseExistingServer: true, timeout: 180_000 },
  ],
});
