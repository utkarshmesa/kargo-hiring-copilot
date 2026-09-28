import { z } from "zod";
import type { PoolConfig } from "./defaults";

// PRD §9: each weight 0–30, each role's weights sum to 100, A > B > C.
const weight = z.number().int().min(0).max(30);

const weightSet = (dims: readonly string[]) =>
  z
    .object(Object.fromEntries(dims.map((d) => [d, weight])))
    .strict()
    .refine((w) => Object.values(w).reduce((a: number, b) => a + (b as number), 0) === 100, {
      message: "weights must sum to 100",
    });

export const poolConfigSchema = z
  .object({
    weights: z
      .object({
        PM: weightSet(["D1", "D2", "D3", "D4", "D5", "D6", "D7"]),
        SPM: weightSet(["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9"]),
        CORE: weightSet(["D1", "D2", "D3", "D4", "D5", "D6"]),
      })
      .strict(),
    tiers: z.object({ A: z.number(), B: z.number(), C: z.number() }).strict(),
    d1GateForTierA: z.boolean(),
    pmExperienceFloorYears: z.number().min(0),
    spmExperienceFloorYears: z.number().min(0),
    experienceBandStrict: z.boolean(),
    runsPerCv: z.union([z.literal(3), z.literal(5)]),
    unstableSpread: z.number().int().min(1),
    holdDefaultDays: z.number().int().min(1),
    sendDelayMinutes: z
      .object({ advance: z.number().min(1), hold: z.number().min(1), decline: z.number().min(1) })
      .strict(),
    nudgeAfterDays: z.number().int().min(1),
    retentionDays: z.number().int().min(1),
    offerTargetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict()
  .refine((c) => c.tiers.A > c.tiers.B && c.tiers.B > c.tiers.C, {
    message: "tier thresholds must satisfy A > B > C",
    path: ["tiers"],
  });

export function parsePoolConfig(input: unknown): PoolConfig {
  return poolConfigSchema.parse(input) as PoolConfig;
}
