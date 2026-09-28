import { describe, expect, it } from "vitest";
import { defaultConfig } from "@/lib/config/defaults";
import { parsePoolConfig } from "@/lib/config/validate";

const clone = () => structuredClone(defaultConfig);

describe("pool config validation (PRD §9)", () => {
  it("accepts the defaults", () => {
    expect(() => parsePoolConfig(clone())).not.toThrow();
  });

  it("rejects role weights that do not sum to 100", () => {
    const c = clone();
    c.weights.PM.D1 = 25;
    expect(() => parsePoolConfig(c)).toThrow(/sum to 100/);
  });

  it("rejects a weight above 30", () => {
    const c = clone();
    c.weights.CORE.D1 = 35;
    c.weights.CORE.D2 = 15;
    expect(() => parsePoolConfig(c)).toThrow();
  });

  it("rejects tiers that are not A > B > C", () => {
    const c = clone();
    c.tiers = { A: 55, B: 55, C: 40 };
    expect(() => parsePoolConfig(c)).toThrow(/A > B > C/);
  });

  it("rejects unknown keys and dimensions", () => {
    const c = clone() as unknown as Record<string, unknown>;
    c.extra = true;
    expect(() => parsePoolConfig(c)).toThrow();
    const d = clone();
    (d.weights.PM as Record<string, number>).D8 = 0;
    expect(() => parsePoolConfig(d)).toThrow();
  });
});
