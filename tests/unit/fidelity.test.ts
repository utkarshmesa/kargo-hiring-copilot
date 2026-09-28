import { describe, expect, it, vi } from "vitest";
import type { ExtractorOutput } from "@/lib/gemini/extractor";
import { checkFidelity } from "@/lib/redact/fidelity";
import { formatDuration, parseRawDate, roleSpan } from "@/lib/redact/durations";
import { prepareProfile } from "@/lib/pipeline/prepare";
import { makeDocx } from "../fixtures/build";

const BULLETS = Array.from(
  { length: 18 },
  (_, i) => `Reduced detention charges for importer account ${i + 1} by rebuilding the delivery order follow-up with the carrier desk.`,
);

async function cvBytes() {
  return makeDocx([
    "Kavya Iyengar",
    "kavya@example.com | +91 90000 11111",
    "Operations Executive | Tidewater Cargo Pvt. Ltd. | Jun 2019 – Present",
    ...BULLETS.map((b) => `–  ${b}`),
  ]);
}

function extraction(bullets: string[]): ExtractorOutput {
  return {
    identity: { name: "Kavya Iyengar", emails: ["kavya@example.com"], phones: ["+91 90000 11111"], urls: [], locations: [] },
    roles: [
      { title: "Operations Executive", company_raw: "Tidewater Cargo Pvt. Ltd.", company_descriptor: "Freight forwarder", start_raw: "Jun 2019", end_raw: "Present", bullets },
    ],
    education: [],
    summary_raw: null,
    skills_raw: [],
    relocation_statement: null,
  };
}

describe("fidelity check (Step 5.1)", () => {
  it("passes when every bullet is copied exactly (glyphs and dashes normalised)", async () => {
    const { parseCv } = await import("@/lib/parse");
    const cv = await parseCv(await cvBytes());
    const r = checkFidelity(cv.text, extraction(BULLETS.map((b) => `• ${b.replace("–", "-")}`)));
    expect(r).toMatchObject({ ok: true, bulletsMissing: 0 });
  });

  it("fails when a bullet is altered", async () => {
    const { parseCv } = await import("@/lib/parse");
    const cv = await parseCv(await cvBytes());
    const altered = [...BULLETS];
    altered[3] = altered[3].replace("Reduced", "Slashed");
    expect(checkFidelity(cv.text, extraction(altered))).toMatchObject({ ok: false, bulletsMissing: 1 });
  });

  it("fails coverage when bullets are dropped", async () => {
    const { parseCv } = await import("@/lib/parse");
    const cv = await parseCv(await cvBytes());
    const r = checkFidelity(cv.text, extraction(BULLETS.slice(0, 4)));
    expect(r.ok).toBe(false);
    expect(r.coverage).toBeLessThan(0.6);
  });

  it("retries the Extractor once, then routes to needs_review (extraction_fidelity)", async () => {
    const extract = vi.fn(async () => extraction(BULLETS.slice(0, 4)));
    const r = await prepareProfile({ bytes: await cvBytes(), asOf: new Date("2026-09-28"), extract });
    expect(r.kind).toBe("extraction_fidelity");
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it("recovers when the retry is faithful", async () => {
    const extract = vi.fn().mockResolvedValueOnce(extraction(BULLETS.slice(0, 4))).mockResolvedValueOnce(extraction(BULLETS));
    const r = await prepareProfile({ bytes: await cvBytes(), asOf: new Date("2026-09-28"), extract });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.profile.text).not.toMatch(/Kavya|Tidewater|2019/);
  });
});

describe("durations", () => {
  const asOf = new Date("2026-09-28T00:00:00Z");
  it("parses the common formats", () => {
    expect(parseRawDate("Jan 2022", "start", asOf)).toBe(2022 * 12);
    expect(parseRawDate("September 2021", "start", asOf)).toBe(2021 * 12 + 8);
    expect(parseRawDate("Sept 2021", "start", asOf)).toBe(2021 * 12 + 8);
    expect(parseRawDate("03/2020", "start", asOf)).toBe(2020 * 12 + 2);
    expect(parseRawDate("2019", "start", asOf)).toBe(2019 * 12);
    expect(parseRawDate("2019", "end", asOf)).toBe(2019 * 12 + 11);
    expect(parseRawDate("Present", "end", asOf)).toBe(2026 * 12 + 8);
    expect(parseRawDate("sometime", "start", asOf)).toBeNull();
  });

  it("counts months inclusively and formats them", () => {
    expect(roleSpan("Jun 2020", "Dec 2021", asOf)?.months).toBe(19);
    expect(formatDuration(19)).toBe("1y 7m");
    expect(formatDuration(12)).toBe("1y");
    expect(formatDuration(3)).toBe("3m");
    expect(formatDuration(null)).toBe("duration unknown");
    expect(roleSpan("Dec 2021", "Jun 2020", asOf)).toBeNull();
  });
});
