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
  embedding VECTOR(384) NOT NULL
);

CREATE INDEX IF NOT EXISTS products_embedding_cosine_idx
ON products
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 1);
