import { expect, test } from "@playwright/test";
import { B_CASES, cvLines } from "../fixtures/bcases";
import { makeDocx } from "../fixtures/build";

// PRD §10 E2E: upload → score → decide → undo → decide → email scheduled.
test("upload, score, advance, undo, decline, undo", async ({ page }) => {
  const tag = Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 6).padEnd(6, "q");
  const base = structuredClone(B_CASES.find((c) => c.id === "B6")!.extractor);
  base.identity.name = `Ezra Test${tag}`;
  base.identity.emails = [`ezra.${tag}@example.com`];
  const fileName = `e2e_${tag}.docx`;
  const buffer = Buffer.from(await makeDocx(cvLines(base)));

  await page.goto("/login");
  await page.getByLabel("Password").fill(process.env.ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/shortlist/);
  await expect(page.getByText("Calibration passed")).toBeVisible();

  // Upload straight to storage from the browser.
  await page.goto("/upload");
  await page.getByLabel("Role applied for").selectOption("PM");
  await page.locator('input[type="file"]').setInputFiles({ name: fileName, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer });
  const row = page.getByRole("row").filter({ hasText: fileName });
  await expect(row).toBeVisible();

  // The dashboard processes it: parse → extract → redact → score ×3 → brief.
  await expect(row.getByText(/scored · tier|needs review/)).toBeVisible({ timeout: 8 * 60_000 });
  await row.getByRole("link").click();

  // The card: evidence quotes and the decision panel.
  await expect(page.getByRole("heading", { name: "Scores and evidence" })).toBeVisible();
  await expect(page.locator("blockquote").first()).toBeVisible();

  // Advance → scheduled → Undo.
  await page.getByRole("button", { name: "Advance" }).click();
  await expect(page.getByText(/Email preview/)).toBeVisible();
  await page.getByRole("button", { name: "Confirm advance" }).click();
  await expect(page.getByText(/Advance email · sending in/)).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Undone. You can decide again.")).toBeVisible();

  // Decline → scheduled for 24 h.
  await page.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByText("sends 24 hours after you confirm")).toBeVisible();
  await page.getByRole("button", { name: "Confirm decline" }).click();
  await expect(page.getByText(/Decline email · sending in 2[34]h/)).toBeVisible();
  await expect(page.getByText(/decline · scheduled/)).toBeVisible();

  // Clean up: nothing from the test is ever sent.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Undone. You can decide again.")).toBeVisible();
});
