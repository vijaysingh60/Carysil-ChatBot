import fs from "node:fs";
import path from "node:path";
import { getDbPool } from "../lib/db";
import { EMBEDDING_DIMENSION, embeddingToSqlVector } from "../lib/embeddings";

/**
 * Fills in MISSING product embeddings in whatever database DATABASE_URL points at. It only ever writes the
 * `embedding` column of rows that don't have one — names, prices, images and links are never touched — so it is
 * safe to re-run (it simply finds nothing left to do).
 *
 * Why it exists: chat's semantic search needs `products.embedding`. A database whose rows were loaded without
 * embeddings (production Supabase was) silently falls back to keyword-only search. Do NOT use
 * `npm run embed:products` for this — that script upserts rows from the old data/products.json and would
 * overwrite live product data.
 *
 * Usage (point it at the database to fix; the embedding service defaults to the one in .env.local):
 *   DATABASE_URL='postgresql://…supabase…/postgres' EMBEDDING_API_URL='https://carysil-chatbot.onrender.com' \
 *     npm run backfill:embeddings -- [--dry-run] [--all] [--limit N]
 *
 *   --dry-run   show what would be embedded; write nothing
 *   --all       recompute every active product, not just the ones missing an embedding
 *   --limit N   stop after N products (handy for a first trial)
 */

type Row = {
  id: string;
  name: string;
  category: string;
  material: string | null;
  style: string | null;
  description: string | null;
  features: unknown;
};

function loadLocalEnv(): void {
  for (const fileName of [".env.local", ".env"]) {
    const filePath = path.resolve(process.cwd(), fileName);
    if (!fs.existsSync(filePath)) continue;
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // Variables already set in the shell win, so DATABASE_URL=… on the command line overrides .env.local.
      if (!process.env[key]) process.env[key] = value;
    }
  }
}

/** Same text rule as scripts/importCatalogProducts.ts, so new vectors match the ones already stored. */
function buildEmbeddingText(row: Row): string {
  const features = Array.isArray(row.features) ? (row.features as unknown[]).map(String) : [];
  return [
    `Name: ${row.name}`,
    `Category: ${row.category}`,
    `Material: ${row.material ?? ""}`,
    `Style: ${row.style ?? ""}`,
    `Description: ${row.description ?? ""}`,
    `Features: ${features.join(", ")}`,
  ].join("\n");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Patient on purpose (a script, not a chat turn): the service may be waking from sleep, which takes a while. */
async function embed(text: string): Promise<number[]> {
  const baseUrl = process.env.EMBEDDING_API_URL || "http://127.0.0.1:5001";
  let lastError: unknown;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as { embedding?: number[] };
      if (!Array.isArray(payload.embedding) || payload.embedding.length !== EMBEDDING_DIMENSION) {
        throw new Error("invalid embedding in response");
      }
      return payload.embedding;
    } catch (error) {
      lastError = error;
      if (attempt < 6) await sleep(attempt * 3_000);
    }
  }
  throw new Error(`embedding service failed after 6 attempts: ${(lastError as Error)?.message ?? lastError}`);
}

function describeTarget(connectionString: string | undefined): string {
  if (!connectionString) return "(DATABASE_URL not set)";
  try {
    const url = new URL(connectionString);
    return `${url.hostname}:${url.port || "5432"}${url.pathname}`; // never print the password
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

async function run(): Promise<void> {
  loadLocalEnv();
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const all = args.includes("--all");
  const limitArg = args.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : 0;

  console.log(`Database : ${describeTarget(process.env.DATABASE_URL)}`);
  console.log(`Embedding: ${process.env.EMBEDDING_API_URL || "http://127.0.0.1:5001"}`);

  const pool = getDbPool();
  const { rows } = await pool.query<Row>(
    `SELECT id, name, category, material, style, description, features
     FROM products
     WHERE is_active = true ${all ? "" : "AND embedding IS NULL"}
     ORDER BY id ${limit > 0 ? `LIMIT ${Math.floor(limit)}` : ""}`
  );
  const total = (await pool.query<{ n: string }>("SELECT count(*) AS n FROM products WHERE is_active = true")).rows[0].n;
  console.log(`${rows.length} of ${total} active products ${all ? "to recompute" : "are missing an embedding"}.`);

  if (rows.length === 0) {
    console.log("Nothing to do.");
    await pool.end();
    return;
  }
  if (dryRun) {
    console.log("\nDry run — nothing written. First three texts that would be embedded:\n");
    for (const row of rows.slice(0, 3)) console.log(`--- ${row.id}\n${buildEmbeddingText(row)}\n`);
    await embed("connectivity check"); // fail now, not an hour in, if the service is unreachable
    console.log("Embedding service reachable. Re-run without --dry-run to apply.");
    await pool.end();
    return;
  }

  let done = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const vector = embeddingToSqlVector(await embed(buildEmbeddingText(row)));
      await pool.query(`UPDATE products SET embedding = $2::vector WHERE id = $1`, [row.id, vector]);
      done++;
    } catch (error) {
      failed++;
      console.error(`  failed ${row.id}: ${(error as Error).message}`);
    }
    if ((done + failed) % 25 === 0 || done + failed === rows.length) {
      console.log(`  ${done + failed}/${rows.length} processed (${failed} failed)`);
    }
  }

  const left = (
    await pool.query<{ n: string }>("SELECT count(*) AS n FROM products WHERE is_active = true AND embedding IS NULL")
  ).rows[0].n;
  console.log(`\nDone: ${done} embedded, ${failed} failed. Active products still without an embedding: ${left}.`);
  await pool.end();
  if (failed > 0) process.exitCode = 1;
}

run().catch((error) => {
  console.error("Backfill failed:", error);
  process.exit(1);
});
