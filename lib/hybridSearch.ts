import { searchSimilarProducts, expandVectorCategories, type SimilarProduct } from "@/lib/vectorSearch";
import { getDbPool } from "@/lib/db";
import { buildTsQuery, ftsRankToSimilarity } from "@/lib/textSearch";

type SearchOptions = {
  limit?: number;
  categories?: string[];
  material?: string;
  style?: string;
  keywords?: string[];
  minPrice?: number;
  maxPrice?: number;
};

async function searchByFTS(
  query: string,
  options: SearchOptions
): Promise<SimilarProduct[]> {
  // A stopword-only or punctuation-only query has nothing meaningful to
  // search on — skip FTS rather than let to_tsquery match everything.
  const tsQuery = buildTsQuery(query);
  if (!tsQuery) return [];

  const pool = getDbPool();
  const params: Array<string | number | string[]> = [tsQuery];
  const where: string[] = [
    "is_active = true",
    `to_tsvector('english', COALESCE(search_text, '')) @@ to_tsquery('english', $1)`,
  ];

  if (options.categories && options.categories.length > 0) {
    params.push(expandVectorCategories(options.categories, options.keywords));
    where.push(`category = ANY($${params.length}::text[])`);
  }
  if (options.material) {
    params.push(`%${options.material}%`);
    where.push(`LOWER(COALESCE(material, '')) LIKE LOWER($${params.length})`);
  }
  if (typeof options.minPrice === "number") {
    params.push(options.minPrice);
    where.push(`price_min >= $${params.length}`);
  }
  if (typeof options.maxPrice === "number") {
    params.push(options.maxPrice);
    where.push(`price_max <= $${params.length}`);
  }

  params.push(options.limit ?? 5);
  const { rows } = await pool.query<SimilarProduct & { rank: number }>(
    `SELECT id, name, category, material, style, size, description, price, url, image_url,
            ts_rank(to_tsvector('english', COALESCE(search_text, '')), to_tsquery('english', $1)) AS rank
     FROM products
     WHERE ${where.join(" AND ")}
     ORDER BY rank DESC
     LIMIT $${params.length}`,
    params
  );
  return rows.map((row) => ({ ...row, similarity: ftsRankToSimilarity(Number(row.rank)) }));
}

/** Standard RRF constant from Cormack et al.; dampens top-rank dominance. */
const RRF_K = 60;

/**
 * Reciprocal Rank Fusion: score(d) = Σ 1/(k + rank_i(d)) across result lists.
 * Products that rank well in both vector and FTS rise to the top; a strong
 * hit in only one list can still surface, but consensus wins.
 */
function reciprocalRankFusion(
  lists: SimilarProduct[][],
  limit: number,
  k: number = RRF_K
): SimilarProduct[] {
  const scores = new Map<string, number>();
  const byId = new Map<string, SimilarProduct>();

  for (const list of lists) {
    list.forEach((item, index) => {
      const rank = index + 1; // 1-indexed
      scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + rank));
      if (!byId.has(item.id)) {
        byId.set(item.id, item);
      }
    });
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, rrfScore]) => ({
      ...byId.get(id)!,
      similarity: rrfScore,
    }));
}

export async function hybridSearch(
  query: string,
  options: SearchOptions = {}
): Promise<SimilarProduct[]> {
  const limit = options.limit ?? 5;
  const candidateLimit = Math.max(limit * 2, 10);

  const [vectorResults, ftsResults] = await Promise.allSettled([
    searchSimilarProducts(query, {
      limit: candidateLimit,
      filters: {
        categories: options.categories,
        material: options.material,
        style: options.style,
        keywords: options.keywords,
        minPrice: options.minPrice,
        maxPrice: options.maxPrice,
      },
    }),
    searchByFTS(query, { ...options, limit: candidateLimit }),
  ]);

  const vector = vectorResults.status === "fulfilled" ? vectorResults.value : [];
  const fts = ftsResults.status === "fulfilled" ? ftsResults.value : [];

  return reciprocalRankFusion([vector, fts], limit);
}
