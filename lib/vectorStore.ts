import { getDbPool } from "@/lib/db";
import { EMBEDDING_DIMENSION, embeddingToSqlVector } from "@/lib/embeddings";

export type ProductRecord = {
  id: string;
  name: string;
  category: string;
  material?: string | null;
  style?: string | null;
  size?: string | null;
  description?: string | null;
  price?: string | null;
  url?: string | null;
  image_url?: string | null;
};

export const CREATE_PRODUCTS_VECTOR_TABLE_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  material TEXT,
  style TEXT,
  size TEXT,
  description TEXT,
  price TEXT,
  url TEXT,
  image_url TEXT,
  embedding VECTOR(${EMBEDDING_DIMENSION}) NOT NULL
);

-- No ANN index here deliberately: an IVFFlat index this small (hundreds of
-- rows) is worse than a sequential scan — see
-- db/migrations/2026_08_drop_undersized_ivfflat_indexes.sql. Re-add one
-- (sized ~sqrt(row_count), with probes tuned against eval/retrievalEval.ts)
-- once the catalogue is large enough to need approximate search.
`;

export async function ensureVectorSchema(): Promise<void> {
  const pool = getDbPool();
  await pool.query(CREATE_PRODUCTS_VECTOR_TABLE_SQL);
}

export async function upsertProductEmbedding(
  product: ProductRecord,
  embedding: number[]
): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `
    INSERT INTO products (
      id, name, category, material, style, size, description, price, url, image_url, embedding
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      category = EXCLUDED.category,
      material = EXCLUDED.material,
      style = EXCLUDED.style,
      size = EXCLUDED.size,
      description = EXCLUDED.description,
      price = EXCLUDED.price,
      url = EXCLUDED.url,
      image_url = EXCLUDED.image_url,
      embedding = EXCLUDED.embedding
    `,
    [
      product.id,
      product.name,
      product.category,
      product.material ?? null,
      product.style ?? null,
      product.size ?? null,
      product.description ?? null,
      product.price ?? null,
      product.url ?? null,
      product.image_url ?? null,
      embeddingToSqlVector(embedding),
    ]
  );
}
