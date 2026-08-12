-- Carysil AskCary — switch product/document full-text search from the
-- 'simple' text search config to 'english'.
--
-- 'simple' does no stemming and no stopword removal, so an OR-joined
-- tsquery built from a natural-language question ("what is the price of
-- the blender?") matched the ENTIRE 586-row catalogue on "the"/"of"/"is"
-- alone (verified during the RAG audit — see lib/textSearch.ts). It also
-- misses plain singular/plural variants ("burner" vs "burners") because
-- there is no stemming. 'english' fixes both: it has a built-in stopword
-- list and stems tokens to a common root.
--
-- Safe to re-run. The GIN index expression must match the query's
-- to_tsvector(...) config exactly for Postgres to use the index instead of
-- a sequential scan — both are updated together here.

DROP INDEX IF EXISTS products_search_text_idx;
CREATE INDEX IF NOT EXISTS products_search_text_idx
ON products
USING gin (to_tsvector('english', COALESCE(search_text, '')));

-- documents.content had no FTS index at all (searchByFts in
-- lib/documentSearch.ts always did a sequential scan) — harmless at 158
-- rows, but added here since the table is being populated as part of this
-- audit and the query shape already assumes an indexable expression.
CREATE INDEX IF NOT EXISTS documents_fts_idx
ON documents
USING gin (to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(content, '')));
