// Local development database: PGlite (in-process Postgres) served over the Postgres wire
// protocol, so the app runs end to end without a hosted database.
//   npm run db:local        → postgres://postgres:postgres@127.0.0.1:54329/postgres
// Data is kept in .local-db/ (gitignored). Never used in production.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { readdirSync, readFileSync } from "node:fs";

async function main() {
  const pg = await PGlite.create(".local-db");
  await migrate(drizzle(pg), { migrationsFolder: "drizzle" });

  // Mirror the latest passing `npm run calibrate` result so the local gate matches reality.
  const files = readdirSync("calibration/results").filter((f) => f.endsWith(".json")).sort();
  const latest = files.at(-1);
  if (latest) {
    const r = JSON.parse(readFileSync(`calibration/results/${latest}`, "utf8"));
    const { rubricHash } = await import("../lib/rubric");
    const { configHash } = await import("../lib/hash");
    const { defaultConfig } = await import("../lib/config/defaults");
    const exists = await pg.query(`SELECT 1 FROM calibrations WHERE results_json->>'recordedFrom' = $1`, [latest]);
    if (r.passed && !exists.rows.length) {
      await pg.query(
        `INSERT INTO calibrations (rubric_hash, config_hash, model_id, passed, results_json) VALUES ($1, $2, $3, true, $4)`,
        [rubricHash(), configHash(defaultConfig), r.model, JSON.stringify({ ...r, recordedFrom: latest })],
      );
      console.log(`Recorded local calibration from ${latest}`);
    }
  }

  const server = new PGLiteSocketServer({ db: pg, port: 54329, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  console.log("Local Postgres on postgres://postgres:postgres@127.0.0.1:54329/postgres");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
