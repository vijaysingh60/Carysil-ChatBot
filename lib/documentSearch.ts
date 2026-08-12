import { createEmbedding, embeddingToSqlVector } from "@/lib/embeddings";
import { getDbPool } from "@/lib/db";
import { hashKey, retrievalCache } from "@/lib/cache";
import { buildTsQuery, ftsRankToSimilarity } from "@/lib/textSearch";

export type DocumentMatch = {
  id: string;
  title: string;
  documentType: string;
  content: string;
  url: string | null;
  similarity: number;
};

type SearchOptions = {
  limit?: number;
  documentTypes?: string[];
};

type DocumentRow = {
  id: string;
  title: string;
  document_type: string;
  content: string;
  url: string | null;
  similarity: number;
};

type FtsDocumentRow = DocumentRow & { rank: number };

function toMatch(row: DocumentRow): DocumentMatch {
  return {
    id: row.id,
    title: row.title,
    documentType: row.document_type,
    content: row.content,
    url: row.url,
    similarity: Number(row.similarity) || 0,
  };
}

async function searchByVector(query: string, options: SearchOptions): Promise<DocumentMatch[]> {
  const limit = options.limit ?? 5;
  const queryEmbedding = await createEmbedding(query);
  const vectorParam = embeddingToSqlVector(queryEmbedding);
  const sqlParams: Array<string | number | string[]> = [vectorParam];
  const where: string[] = ["embedding IS NOT NULL"];

  if (options.documentTypes && options.documentTypes.length > 0) {
    sqlParams.push(options.documentTypes);
    where.push(`document_type = ANY($${sqlParams.length}::text[])`);
  }

  sqlParams.push(limit);
  const pool = getDbPool();
  const { rows } = await pool.query<DocumentRow>(
    `
    SELECT id, title, document_type, content, url,
           1 - (embedding <=> $1::vector) AS similarity
    FROM documents
    WHERE ${where.join(" AND ")}
    ORDER BY embedding <=> $1::vector
    LIMIT $${sqlParams.length}
    `,
    sqlParams
  );
  return rows.map(toMatch);
}

async function searchByFts(query: string, options: SearchOptions): Promise<DocumentMatch[]> {
  const limit = options.limit ?? 5;
  const tsQuery = buildTsQuery(query);
  if (!tsQuery) return [];

  const sqlParams: Array<string | number | string[]> = [tsQuery];
  const where: string[] = [
    `to_tsvector('english', title || ' ' || content) @@ to_tsquery('english', $1)`,
  ];

  if (options.documentTypes && options.documentTypes.length > 0) {
    sqlParams.push(options.documentTypes);
    where.push(`document_type = ANY($${sqlParams.length}::text[])`);
  }

  sqlParams.push(limit);
  const pool = getDbPool();
  const { rows } = await pool.query<FtsDocumentRow>(
    `
    SELECT id, title, document_type, content, url,
           ts_rank(to_tsvector('english', title || ' ' || content), to_tsquery('english', $1)) AS rank
    FROM documents
    WHERE ${where.join(" AND ")}
    ORDER BY rank DESC
    LIMIT $${sqlParams.length}
    `,
    sqlParams
  );
  return rows.map((row) =>
    toMatch({
      ...row,
      similarity: ftsRankToSimilarity(Number(row.rank)),
    })
  );
}

function mergeResults(vector: DocumentMatch[], fts: DocumentMatch[], limit: number): DocumentMatch[] {
  const seen = new Set<string>();
  const merged: DocumentMatch[] = [];

  // Vector results first — cosine similarity is the primary grounding signal.
  // FTS fillers keep their mapped similarity so handlers can accept strong
  // lexical hits when embeddings are missing or weak.
  for (const doc of vector) {
    if (!seen.has(doc.id)) {
      merged.push(doc);
      seen.add(doc.id);
    }
  }
  for (const doc of fts) {
    if (!seen.has(doc.id) && merged.length < limit * 2) {
      merged.push(doc);
      seen.add(doc.id);
    }
  }

  return merged.slice(0, limit);
}

/**
 * Hybrid vector + full-text search over the `documents` knowledge base
 * (FAQs, guides, spec sheets — see document_type). Mirrors the products
 * hybridSearch/vectorSearch pattern in lib/hybridSearch.ts + lib/vectorSearch.ts.
 */
export async function searchDocuments(
  query: string,
  options: SearchOptions = {}
): Promise<DocumentMatch[]> {
  const limit = options.limit ?? 5;

  const cacheKey = hashKey(
    `doc|${query.trim().toLowerCase()}|${limit}|${(options.documentTypes ?? []).join(",")}`
  );
  const cached = retrievalCache.get(cacheKey) as DocumentMatch[] | undefined;
  if (cached) return cached;

  const [vectorResults, ftsResults] = await Promise.allSettled([
    searchByVector(query, { ...options, limit: limit * 2 }),
    searchByFts(query, { ...options, limit }),
  ]);

  const vector = vectorResults.status === "fulfilled" ? vectorResults.value : [];
  const fts = ftsResults.status === "fulfilled" ? ftsResults.value : [];

  const merged = mergeResults(vector, fts, limit);
  retrievalCache.set(cacheKey, merged);
  return merged;
}
