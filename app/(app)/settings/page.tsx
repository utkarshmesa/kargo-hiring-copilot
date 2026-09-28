import { db } from "@/lib/db/client";
import { currentPool, poolConfig } from "@/lib/pools";
import SettingsForm from "./settings-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  let pool;
  try {
    pool = await currentPool(db());
  } catch {
    return <p className="text-sm text-zinc-600">The database is not connected yet.</p>;
  }
  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Settings · {pool.name}</h1>
      <p className="text-sm text-zinc-700">
        Config hash {pool.configHash.slice(0, 12)}… · {pool.lockedAt ? `locked since ${pool.lockedAt.toDateString()} (first decision made)` : "editable until the first decision"}
        {pool.closedAt ? ` · closed ${pool.closedAt.toDateString()}` : ""}
      </p>
      <SettingsForm config={poolConfig(pool)} locked={!!pool.lockedAt || !!pool.closedAt} closed={!!pool.closedAt} />
    </section>
  );
}
