import { defaultConfig } from "@/lib/config/defaults";
import { weeksLeft } from "@/lib/dates";

export const dynamic = "force-dynamic";

export default function PipelinePage() {
  const weeks = weeksLeft(defaultConfig.offerTargetDate);
  return (
    <section>
      <h1 className="text-xl font-semibold">Pipeline</h1>
      <p className="mt-2 text-sm">
        <strong>{weeks} weeks</strong> left to the offer target ({defaultConfig.offerTargetDate}).
      </p>
      <p className="mt-2 text-sm text-zinc-600">No candidates in the pipeline yet.</p>
    </section>
  );
}
