import { describe, expect, it } from "vitest";
import { checkLeaks } from "@/lib/redact/leak";
import { buildRedactedProfile } from "@/lib/redact/profile";
import { buildTerms, companyTerms, emptyCounts, redactText, renderPlaceholders } from "@/lib/redact/redact";
import { sampleExtractor } from "../fixtures/extractor";

const AS_OF = new Date("2026-09-28T00:00:00Z");

describe("redaction leak suite (PRD §10: zero leaks)", () => {
  const ex = sampleExtractor();
  const p = buildRedactedProfile(ex, AS_OF);
  const text = p.text;

  it("produces a profile with no leaks at all", () => {
    expect(checkLeaks(text, p.terms)).toEqual([]);
  });

  it("removes the name wherever it appears: summary, quotes, possessives", () => {
    expect(text).not.toMatch(/priya|raghavan/i);
    expect(text).toContain("[CANDIDATE] owns every escalation");
  });

  it("removes a name that appears only at the bottom of the CV", () => {
    const bottom = sampleExtractor({ summary_raw: "Freight operations professional.", skills_raw: ["Excel"] });
    bottom.roles[0].bullets.push("Reference available on request. — Priya R.");
    const q = buildRedactedProfile(bottom, AS_OF);
    expect(q.text).not.toMatch(/priya/i);
    expect(checkLeaks(q.text, q.terms)).toEqual([]);
  });

  it("neutralises pronouns inside quotes", () => {
    expect(text).toMatch(/They never waits to be asked, and their fixes stick/);
    expect(text).not.toMatch(/\b(she|her|he|him|his|hers)\b/i);
  });

  it("replaces referees' names and honorifics", () => {
    expect(text).toContain("worked with [REFEREE] on customs holds");
    expect(text).not.toMatch(/Kulkarni|Mr\b/);
  });

  it("removes colleges, from the identity and from the seed list", () => {
    expect(text).not.toMatch(/Symbiosis|IIM|Ahmedabad/);
    expect(text).toContain("[DEGREE: B.Com, Accounting]");
  });

  it("removes cities, states and ports", () => {
    expect(text).not.toMatch(/Pune|Maharashtra|JNPT|Mumbai/);
    expect(text).toContain("[LOCATION]");
  });

  it("removes company names, including inside bullets", () => {
    expect(text).not.toMatch(/Zephyrline|Harbourstone/);
    expect(text).toContain("[COMPANY]'s first exception dashboard");
    expect(text).toContain("Mid-sized freight forwarder, ~120 staff");
  });

  it("turns dates into durations and removes calendar dates", () => {
    expect(text).not.toMatch(/\b(19|20)\d{2}\b/);
    expect(text).not.toMatch(/\b(Jan|Mar|Jul|Feb)\b/);
    expect(text).toContain("Operations Lead · 5y 7m");
    expect(text).toContain("Documentation Executive · 2y 8m");
  });

  it("drops gap and break sentences entirely", () => {
    expect(text).not.toMatch(/career break|care for family|Returned to work/i);
    expect(p.counts.gapUnits).toBe(1);
  });

  it("drops protected personal details and human languages", () => {
    expect(text).not.toMatch(/Married|children|Marathi|Hindi|English/);
    expect(text).toContain("Python");
    expect(p.counts.personalUnits).toBeGreaterThan(0);
  });

  it("keeps programming languages in a mixed languages entry", () => {
    const q = buildRedactedProfile(sampleExtractor({ skills_raw: ["Languages: Python, Hindi, Go"] }), AS_OF);
    expect(q.text).toContain("Languages: Python, Go");
    expect(q.text).not.toContain("Hindi");
  });

  it("removes contact details", () => {
    const s = redactText("Call +91 98765 43210 or priya.raghavan@example.com, see linkedin.com/in/priyaraghavan", buildTerms(ex), emptyCounts());
    expect(s).not.toMatch(/98765|example\.com|linkedin/);
  });

  it("keeps metrics that look like numbers but are not dates or phones", () => {
    const s = redactText("Cut CAC by 28% to ₹5,900; 2M+ events; 3,200 employees; 40+ clients", buildTerms(ex), emptyCounts());
    expect(s).toBe("Cut CAC by 28% to ₹5,900; 2M+ events; 3,200 employees; 40+ clients");
  });
});

describe("leak check catches what redaction misses", () => {
  const ex = sampleExtractor();
  const terms = buildTerms(ex);

  it.each([
    ["name", "Led the team with Raghavan."],
    ["email", "Write to someone@corp.in"],
    ["phone", "Phone 98765 43210"],
    ["location", "Moved to Pune."],
    ["city_list", "Worked in Hyderabad."],
    ["college_list", "Studied at IIT Bombay."],
    ["company", "Joined Zephyrline."],
    ["date", "Promoted in March 2023."],
    ["date", "Joined in 2019."],
    ["gendered_word", "She shipped it."],
  ])("flags %s", (category, leak) => {
    expect(checkLeaks(`[SUMMARY]\n${leak}\n`, terms)).toContain(category);
  });

  it("flags a CV whose name was not found at all", () => {
    const t = buildTerms(sampleExtractor({ identity: { ...ex.identity, name: null } }));
    expect(checkLeaks("[SUMMARY]\nclean text\n", t)).toContain("name_not_found");
  });

  it("does not flag 'MS Excel' or placeholders", () => {
    expect(checkLeaks("[SKILLS]\nMS Excel · [CANDIDATE] · [DATE] · [LOCATION]\n", terms)).toEqual([]);
  });
});

describe("company terms", () => {
  it.each([
    ["Blue Anchor Freight Pvt. Ltd.", "Blue Anchor"],
    ["Desai CHA & Logistics Pvt. Ltd.", "Desai"],
    ["Mahindra Logistics Ltd.", "Mahindra"],
    ["Springboard HR Technologies (Series B, B2B SaaS)", "Springboard"],
  ])("%s → %s", (raw, lead) => {
    expect(companyTerms(raw)).toContain(lead);
    expect(companyTerms(raw)).not.toContain("Logistics");
  });

  it("ignores self-employment", () => {
    expect(companyTerms("Self-employed")).toEqual([]);
  });
});

describe("counts that look like years", () => {
  const terms = buildTerms(sampleExtractor());
  it.each([
    ["Financial Technology, 2000+ employees", "Financial Technology, 2000+ employees"],
    ["handled 1999 shipments a month", "handled 1999 shipments a month"],
    ["grew to 2010 clients", "grew to 2010 clients"],
  ])("keeps %j", (input, want) => {
    expect(redactText(input, terms, emptyCounts())).toBe(want);
    expect(checkLeaks(`[SUMMARY]\n${want}\n`, terms)).toEqual([]);
  });

  it("still removes real years", () => {
    expect(renderPlaceholders(redactText("Joined in 2019, promoted 2021", terms, emptyCounts()))).toBe("Joined in [DATE], promoted [DATE]");
  });
});
