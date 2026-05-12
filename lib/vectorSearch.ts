import { createEmbedding, embeddingToSqlVector } from "@/lib/embeddings";
import { getDbPool } from "@/lib/db";

export type SimilarProduct = {
  id: string;
  name: string;
  category: string;
  material: string | null;
  style: string | null;
  size: string | null;
  description: string | null;
  price: string | null;
  url: string | null;
  image_url: string | null;
  similarity: number;
};

type SearchFilters = {
  categories?: string[];
  material?: string;
  style?: string;
  keywords?: string[];
  maxPrice?: number;
  minPrice?: number;
};

const MATERIAL_WORDS = [
  "quartz",
  "stainless steel",
  "granite",
  "steel",
  "ceramic",
  "brass",
];

const STYLE_WORDS = ["modern", "classic", "minimal", "premium", "contemporary"];

function parseBudget(text: string): { maxPrice?: number; minPrice?: number } {
  const normalized = text.toLowerCase();
  const underMatch = normalized.match(/\b(?:under|below|less than)\s*(?:rs\.?|₹)?\s*([\d,]+)/i);
  if (underMatch) {
    return { maxPrice: Number(underMatch[1].replace(/,/g, "")) };
  }
  const overMatch = normalized.match(/\b(?:above|over|more than)\s*(?:rs\.?|₹)?\s*([\d,]+)/i);
  if (overMatch) {
    return { minPrice: Number(overMatch[1].replace(/,/g, "")) };
  }
  const between = normalized.match(
    /\bbetween\s*(?:rs\.?|₹)?\s*([\d,]+)\s*(?:and|-|to)\s*(?:rs\.?|₹)?\s*([\d,]+)/i
  );
  if (between) {
    const minPrice = Number(between[1].replace(/,/g, ""));
    const maxPrice = Number(between[2].replace(/,/g, ""));
    if (!Number.isNaN(minPrice) && !Number.isNaN(maxPrice)) {
      return { minPrice: Math.min(minPrice, maxPrice), maxPrice: Math.max(minPrice, maxPrice) };
    }
  }
  return {};
}

function inferHybridFilters(query: string, base?: Partial<SearchFilters>): SearchFilters {
  const normalized = query.toLowerCase();
  const material = MATERIAL_WORDS.find((m) => normalized.includes(m)) || base?.material;
  const style = STYLE_WORDS.find((s) => normalized.includes(s)) || base?.style;
  const keywords = (base?.keywords || []).slice();
  if (/\bdouble\s*bowl\b/i.test(normalized)) keywords.push("double bowl");
  if (/\bsingle\s*bowl\b/i.test(normalized)) keywords.push("single bowl");
  if (/\bblack\b/i.test(normalized)) keywords.push("black");
  if (/\bmodular kitchen\b/i.test(normalized)) keywords.push("kitchen");
  const { minPrice, maxPrice } = parseBudget(normalized);
  return {
    ...base,
    material,
    style,
    keywords: Array.from(new Set(keywords)),
    minPrice: base?.minPrice ?? minPrice,
    maxPrice: base?.maxPrice ?? maxPrice,
  };
}

function expandVectorCategories(categories: string[], keywords?: string[]): string[] {
  const expanded = new Set<string>();
  const normalizedKeywords = (keywords || []).map((keyword) => keyword.toLowerCase());
  for (const category of categories) {
    expanded.add(category);
    if (category === "Appliance") {
      expanded.add("Hob");
      if (normalizedKeywords.includes("chimney")) {
        expanded.add("Combo");
      }
    }
  }
  return Array.from(expanded);
}

export async function searchSimilarProducts(
  query: string,
  options?: {
    limit?: number;
    filters?: Partial<SearchFilters>;
  }
): Promise<SimilarProduct[]> {
  const limit = options?.limit ?? 5;
  const filters = inferHybridFilters(query, options?.filters);
  const queryEmbedding = await createEmbedding(query);
  const vectorParam = embeddingToSqlVector(queryEmbedding);
  const sqlParams: Array<string | number | string[]> = [vectorParam];
  const where: string[] = [];

  if (filters.categories && filters.categories.length > 0) {
    sqlParams.push(expandVectorCategories(filters.categories, filters.keywords));
    where.push(`category = ANY($${sqlParams.length}::text[])`);
  }
  if (filters.material) {
    sqlParams.push(`%${filters.material}%`);
    where.push(`LOWER(COALESCE(material, '')) LIKE LOWER($${sqlParams.length})`);
  }
  if (filters.style) {
    sqlParams.push(`%${filters.style}%`);
    where.push(`LOWER(COALESCE(style, '')) LIKE LOWER($${sqlParams.length})`);
  }
  if (typeof filters.minPrice === "number" || typeof filters.maxPrice === "number") {
    const priceExpr =
      "NULLIF(REGEXP_REPLACE(COALESCE(price, ''), '[^0-9.]', '', 'g'), '')::numeric";
    if (typeof filters.minPrice === "number") {
      sqlParams.push(filters.minPrice);
      where.push(`${priceExpr} >= $${sqlParams.length}`);
    }
    if (typeof filters.maxPrice === "number") {
      sqlParams.push(filters.maxPrice);
      where.push(`${priceExpr} <= $${sqlParams.length}`);
    }
  }
  if (filters.keywords && filters.keywords.length > 0) {
    const keywordClauses: string[] = [];
    for (const keyword of filters.keywords) {
      sqlParams.push(`%${keyword}%`);
      const p = `$${sqlParams.length}`;
      keywordClauses.push(
        `(LOWER(COALESCE(name, '')) LIKE LOWER(${p}) OR LOWER(COALESCE(description, '')) LIKE LOWER(${p}))`
      );
    }
    if (keywordClauses.length > 0) {
      where.push(`(${keywordClauses.join(" AND ")})`);
    }
  }

  sqlParams.push(limit);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const pool = getDbPool();
  const { rows } = await pool.query<SimilarProduct>(
    `
    SELECT
      id,
      name,
      category,
      material,
      style,
      size,
      description,
      price,
      url,
      image_url,
      1 - (embedding <=> $1::vector) AS similarity
    FROM products
    ${whereSql}
    ORDER BY embedding <=> $1::vector
    LIMIT $${sqlParams.length}
    `,
    sqlParams
  );

  return rows;
}
