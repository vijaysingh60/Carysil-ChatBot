import fs from "node:fs";
import path from "node:path";
import { getDbPool } from "../lib/db";
import { hybridSearch } from "../lib/hybridSearch";
import { searchSimilarProducts } from "../lib/vectorSearch";
import type { GoldenCase } from "./types";

/**
 * Retrieval-only evaluation. Calls the SAME lib/hybridSearch.ts and
 * lib/vectorSearch.ts used by the live API route — no mocking — against
 * every applicable case in eval/golden-dataset.json, then computes
 * Recall@K / Precision@K / MRR for both hybrid (vector+FTS) and
 * vector-only retrieval so the two can be compared.
 *
 * Usage: node --import tsx eval/retrievalEval.ts [--mode=hybrid|vector] [--out=eval/retrieval-report.json]
 */

function loadLocalEnv(): void {
  for (const fileName of [".env.local", ".env"]) {
    const filePath = path.resolve(process.cwd(), fileName);
    if (!fs.existsSync(filePath)) continue;
    const raw = fs.readFileSync(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  }
}

const RETRIEVABLE_CATEGORIES = new Set([
  "product_lookup_name",
  "product_lookup_id",
  "attribute_dimension",
  "attribute_material",
  "attribute_price",
  "attribute_installation",
  "attribute_color",
  "semantic_paraphrase",
  "semantic_typo",
  "filtering",
  "comparison",
  "multi_hop",
]);

type PerQueryResult = {
  id: string;
  category: string;
  question: string;
  expected: string[];
  retrieved_top10: string[];
  scores_top10: number[];
  rank_of_first_hit: number | null; // 1-indexed, null if not found in top10
  recall_at: Record<1 | 3 | 5 | 10, number>; // fraction of expected ids found in top-K (for multi-expected cases)
  precision_at_5: number;
};

function recallAtK(expected: string[], retrieved: string[], k: number): number {
  if (expected.length === 0) return retrieved.length === 0 ? 1 : 0; // no-expectation cases handled separately
  const topK = new Set(retrieved.slice(0, k));
  const hits = expected.filter((id) => topK.has(id)).length;
  return hits / expected.length;
}

function precisionAtK(expected: string[], retrieved: string[], k: number): number {
  const topK = retrieved.slice(0, k);
  if (topK.length === 0) return 0;
  const expectedSet = new Set(expected);
  const hits = topK.filter((id) => expectedSet.has(id)).length;
  return hits / topK.length;
}

async function runMode(cases: GoldenCase[], mode: "hybrid" | "vector"): Promise<PerQueryResult[]> {
  const results: PerQueryResult[] = [];
  for (const c of cases) {
    if (!RETRIEVABLE_CATEGORIES.has(c.category)) continue;
    if (c.expected_sources.length === 0 && c.should_have_answer) continue; // skip malformed

    let matches: Array<{ id: string; similarity: number }>;
    if (mode === "hybrid") {
      const filter = (c.meta?.filter ?? {}) as { category?: string; material?: string; maxPrice?: number };
      matches = await hybridSearch(c.question, {
        limit: 10,
        categories: filter.category ? [filter.category] : undefined,
        material: filter.material,
        maxPrice: filter.maxPrice,
      });
    } else {
      matches = await searchSimilarProducts(c.question, { limit: 10 });
    }

    const retrieved = matches.map((m) => m.id);
    const scores = matches.map((m) => Number((m as { similarity: number }).similarity ?? 0));
    const firstHitRank = c.expected_sources.length
      ? (() => {
          for (let i = 0; i < retrieved.length; i++) {
            if (c.expected_sources.includes(retrieved[i])) return i + 1;
          }
          return null;
        })()
      : null;

    results.push({
      id: c.id,
      category: c.category,
      question: c.question,
      expected: c.expected_sources,
      retrieved_top10: retrieved,
      scores_top10: scores,
      rank_of_first_hit: firstHitRank,
      recall_at: {
        1: recallAtK(c.expected_sources, retrieved, 1),
        3: recallAtK(c.expected_sources, retrieved, 3),
        5: recallAtK(c.expected_sources, retrieved, 5),
        10: recallAtK(c.expected_sources, retrieved, 10),
      },
      precision_at_5: precisionAtK(c.expected_sources, retrieved, 5),
    });
  }
  return results;
}

function aggregate(results: PerQueryResult[]) {
  const withExpectation = results.filter((r) => r.expected.length > 0);
  const n = withExpectation.length || 1;
  const avg = (sel: (r: PerQueryResult) => number) =>
    withExpectation.reduce((sum, r) => sum + sel(r), 0) / n;

  const mrr =
    withExpectation.reduce((sum, r) => sum + (r.rank_of_first_hit ? 1 / r.rank_of_first_hit : 0), 0) / n;

  const misses = withExpectation.filter((r) => r.rank_of_first_hit === null);

  return {
    n_queries: withExpectation.length,
    recall_at_1: avg((r) => r.recall_at[1]),
    recall_at_3: avg((r) => r.recall_at[3]),
    recall_at_5: avg((r) => r.recall_at[5]),
    recall_at_10: avg((r) => r.recall_at[10]),
    precision_at_5: avg((r) => r.precision_at_5),
    mrr,
    zero_hit_queries: misses.map((m) => ({ id: m.id, question: m.question, expected: m.expected })),
  };
}

async function main() {
  loadLocalEnv();
  const args = process.argv.slice(2);
  const outArg = args.find((a) => a.startsWith("--out="));
  const outPath = outArg ? outArg.split("=")[1] : "eval/retrieval-report.json";

  const datasetPath = path.resolve(process.cwd(), "eval", "golden-dataset.json");
  const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8")) as { cases: GoldenCase[] };

  console.log(`Loaded ${dataset.cases.length} golden cases.`);
  console.log("Running hybrid (vector+FTS) retrieval...");
  const hybridResults = await runMode(dataset.cases, "hybrid");
  console.log("Running vector-only retrieval...");
  const vectorResults = await runMode(dataset.cases, "vector");

  const hybridAgg = aggregate(hybridResults);
  const vectorAgg = aggregate(vectorResults);

  const report = {
    generated_at: new Date().toISOString(),
    hybrid: { aggregate: hybridAgg, per_query: hybridResults },
    vector_only: { aggregate: vectorAgg, per_query: vectorResults },
  };

  fs.writeFileSync(path.resolve(process.cwd(), outPath), JSON.stringify(report, null, 2));

  console.log("\n=== Retrieval Evaluation ===");
  console.log(`Queries evaluated: ${hybridAgg.n_queries}`);
  console.log("\nMode        Recall@1  Recall@3  Recall@5  Recall@10  Precision@5  MRR");
  const row = (label: string, a: ReturnType<typeof aggregate>) =>
    console.log(
      `${label.padEnd(11)} ${(a.recall_at_1 * 100).toFixed(1).padStart(6)}%  ${(a.recall_at_3 * 100)
        .toFixed(1)
        .padStart(6)}%  ${(a.recall_at_5 * 100).toFixed(1).padStart(6)}%  ${(a.recall_at_10 * 100)
        .toFixed(1)
        .padStart(7)}%   ${(a.precision_at_5 * 100).toFixed(1).padStart(8)}%  ${(a.mrr * 100).toFixed(1)}%`
    );
  row("hybrid", hybridAgg);
  row("vector-only", vectorAgg);

  if (hybridAgg.zero_hit_queries.length > 0) {
    console.log(`\nZero-hit queries (hybrid, expected id never appeared in top 10): ${hybridAgg.zero_hit_queries.length}`);
    for (const q of hybridAgg.zero_hit_queries.slice(0, 15)) {
      console.log(`  - [${q.id}] "${q.question}" expected=${JSON.stringify(q.expected)}`);
    }
  }
  console.log(`\nFull report written to ${outPath}`);

  await getDbPool().end();
}

main().catch((err) => {
  console.error("Retrieval eval failed:", err);
  process.exit(1);
});
