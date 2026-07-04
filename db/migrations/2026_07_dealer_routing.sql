-- Carysil AskCary — Dealer lead routing (additive, idempotent)
--
-- Makes `dealers` / `dealer_products` reproducible from the repo (previously
-- created directly against the DB, same as the `products` table upgrade),
-- and adds the column that lets a lead be routed to a specific dealer.
--
-- Safe to re-run. All statements use IF NOT EXISTS so this file matches the
-- existing bootstrap pattern in services/sessionService.ts.

CREATE TABLE IF NOT EXISTS dealers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  contact_email TEXT,
  phone TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS dealers_active_idx ON dealers (is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS dealers_city_idx ON dealers (city);
CREATE INDEX IF NOT EXISTS dealers_state_idx ON dealers (state);

CREATE TABLE IF NOT EXISTS dealer_products (
  id BIGSERIAL PRIMARY KEY,
  dealer_id TEXT NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (dealer_id, product_id)
);

CREATE INDEX IF NOT EXISTS dealer_products_dealer_idx ON dealer_products (dealer_id);
CREATE INDEX IF NOT EXISTS dealer_products_product_idx ON dealer_products (product_id);

ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_dealer_id TEXT REFERENCES dealers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS leads_assigned_dealer_idx ON leads (assigned_dealer_id);
