// Pool config defaults: PRD §9 / rubric §15. A new pool copies these into pools.config_json.
// Do not change a value here without a matching rubric change and a new calibration run.

export type Dim = "D1" | "D2" | "D3" | "D4" | "D5" | "D6" | "D7" | "D8" | "D9";

export type PoolConfig = {
  weights: {
    PM: Partial<Record<Dim, number>>;
    SPM: Partial<Record<Dim, number>>;
    CORE: Partial<Record<Dim, number>>;
  };
  tiers: { A: number; B: number; C: number };
  d1GateForTierA: boolean;
  pmExperienceFloorYears: number; // 0 = floor off
  spmExperienceFloorYears: number; // 0 = floor off
  experienceBandStrict: boolean;
  runsPerCv: 3 | 5;
  unstableSpread: number;
  holdDefaultDays: number;
  sendDelayMinutes: { advance: number; hold: number; decline: number };
  nudgeAfterDays: number;
  retentionDays: number;
  offerTargetDate: string;
};

export const defaultConfig: PoolConfig = {
  weights: {
    PM: { D1: 20, D2: 15, D3: 15, D4: 15, D5: 15, D6: 5, D7: 15 },
    SPM: { D1: 20, D2: 10, D3: 15, D4: 10, D5: 5, D6: 10, D7: 5, D8: 15, D9: 10 },
    CORE: { D1: 30, D2: 20, D3: 15, D4: 15, D5: 10, D6: 10 },
  },
  tiers: { A: 70, B: 55, C: 40 },
  d1GateForTierA: false,
  pmExperienceFloorYears: 1,
  spmExperienceFloorYears: 4,
  experienceBandStrict: false,
  runsPerCv: 3,
  unstableSpread: 2,
  holdDefaultDays: 21,
  sendDelayMinutes: { advance: 10, hold: 10, decline: 1440 },
  nudgeAfterDays: 3,
  retentionDays: 180,
  offerTargetDate: "2026-12-31",
};
