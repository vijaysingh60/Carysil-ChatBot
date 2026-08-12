-- Carysil AskCary — drop the IVFFlat ANN indexes on products.embedding and
-- documents.embedding.
--
-- Both indexes are catastrophically mis-tuned for the actual table sizes
-- (586 products, 158 documents): products_embedding_cosine_idx was created
-- with `lists = 100` (rule of thumb is lists ~= sqrt(row_count), i.e. ~24
-- here), and pgvector's default `ivfflat.probes = 1` only searches one of
-- those 100 clusters per query. Verified during the RAG audit: an unfiltered
-- nearest-neighbor query with `LIMIT 10` returned exactly 1 row via the
-- index scan, while a sequential (exact) scan on the same query correctly
-- returned 10 rows with the true nearest neighbor at similarity 0.746 in
-- first place — the index was silently starving retrieval of the very
-- product the user asked about.
--
-- At this row count, an ANN index has no upside: a sequential scan
-- computing exact cosine distance over 586/158 rows measured ~4-5ms per
-- query (see eval/retrievalEval.ts timings), and is always exact. Once the
-- catalogue grows into the tens of thousands of rows, an ANN index
-- (IVFFlat with lists ~= sqrt(rows), or HNSW) becomes worth revisiting —
-- but it must be re-tuned for the actual row count then, not left at
-- whatever defaults were used for the current 586-row table, and its
-- probes/ef_search must be validated against a recall eval before shipping
-- it again (see eval/retrievalEval.ts for the harness to use).

DROP INDEX IF EXISTS products_embedding_cosine_idx;
DROP INDEX IF EXISTS documents_embedding_cosine_idx;
