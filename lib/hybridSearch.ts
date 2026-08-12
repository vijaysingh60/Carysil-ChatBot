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

function mergeResults(
  vector: SimilarProduct[],
  fts: SimilarProduct[],
  limit: number
): SimilarProduct[] {
  const seen = new Set<string>();
  const merged: SimilarProduct[] = [];

  // FTS results first — exact keyword matches take priority
  for (const p of fts) {
    if (!seen.has(p.id)) {
      merged.push(p);
      seen.add(p.id);
    }
  }

  // Vector results fill remaining slots
  for (const p of vector) {
    if (!seen.has(p.id) && merged.length < limit * 2) {
      merged.push(p);
      seen.add(p.id);
    }
  }

  return merged.slice(0, limit);
}

export async function hybridSearch(
  query: string,
  options: SearchOptions = {}
): Promise<SimilarProduct[]> {
  const limit = options.limit ?? 5;

  const [vectorResults, ftsResults] = await Promise.allSettled([
    searchSimilarProducts(query, {
      limit: limit * 2,
      filters: {
        categories: options.categories,
        material: options.material,
        style: options.style,
        keywords: options.keywords,
        minPrice: options.minPrice,
        maxPrice: options.maxPrice,
      },
    }),
    searchByFTS(query, { ...options, limit }),
  ]);

  const vector = vectorResults.status === "fulfilled" ? vectorResults.value : [];
  const fts = ftsResults.status === "fulfilled" ? ftsResults.value : [];

  return mergeResults(vector, fts, limit);
}
