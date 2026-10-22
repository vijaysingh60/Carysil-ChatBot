-- ============================================================================
-- Carysil AI — keep only carysil.com products (hide the carysilshop.com ones)
--
-- The catalogue was loaded from two sites. This hides every product whose page
-- is on carysilshop.com (197 of 586 rows) by setting is_active = false; the 389
-- carysil.com products stay active. Nothing is deleted: chat search, the range
-- overview and the dealer/lead tables all ignore inactive rows, and the rows,
-- their embeddings and their history are preserved.
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- Safe to re-run (it only touches rows that are still active).
--
-- BRING THEM BACK LATER:
--   UPDATE products p SET is_active = true
--   FROM products_carysilshop_backup_20261022 b WHERE b.id = p.id;
-- ============================================================================

BEGIN;

-- Remember exactly which rows this changes, so it can be undone precisely.
CREATE TABLE IF NOT EXISTS products_carysilshop_backup_20261022 AS
SELECT id, is_active
FROM products
WHERE is_active = true AND url ILIKE '%carysilshop.com%';

UPDATE products
SET is_active = false, updated_at = NOW()
WHERE is_active = true AND url ILIKE '%carysilshop.com%';

-- Expect: carysilshop_active = 0, carysil_com_active = 389 (or your current carysil.com count)
SELECT
  count(*) FILTER (WHERE is_active AND url ILIKE '%carysilshop.com%') AS carysilshop_active,
  count(*) FILTER (WHERE is_active AND url ILIKE '%carysil.com%' AND url NOT ILIKE '%carysilshop.com%') AS carysil_com_active,
  count(*) FILTER (WHERE NOT is_active) AS inactive_total
FROM products;

COMMIT;
