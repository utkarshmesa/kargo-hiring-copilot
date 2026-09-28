import { db } from "@/lib/db/client";
import { modelId } from "@/lib/gemini/client";
import { calibrationPassed, currentPool } from "@/lib/pools";

// US10: shown until a passing calibration exists for the current rubric hash, this pool's
// config hash and the model ID. While it shows, process-next refuses to score (HTTP 409).
export default async function CalibrationBanner() {
  let passed = false;
  let problem: string | null = null;
  try {
    const database = db();
    passed = await calibrationPassed(database, await currentPool(database), modelId());
  } catch (err) {
    problem = err instanceof Error ? err.message : "unknown error";
  }
  if (passed) {
    return (
      <div role="status" className="border-b border-emerald-300 bg-emerald-50 px-4 py-2 text-center text-sm text-emerald-900">
        Calibration passed for the current rubric, config and model. Scoring is on.
      </div>
    );
  }
  return (
    <div role="alert" className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm text-amber-950">
      {problem
        ? `Setup incomplete: ${problem}.`
        : "Calibration has not passed for the current rubric, config and model. CVs are parsed and redacted, but not scored. Run `npm run calibrate`."}
    </div>
  );
}
