-- Carysil chatbot — Supabase Postgres setup (lead generation + analytics only)
--
-- 1. In Supabase: Project Settings → Database → copy the connection string
--    (use "Transaction" pooler for serverless / Vercel if you use pooling).
-- 2. Set DATABASE_URL in your app to that URL (same as local Postgres).
-- 3. Run this entire file in: Supabase Dashboard → SQL → New query → Run.
--
-- No pgvector extension and no `products` table — use your separate embedding
-- service / local DB if you still need vector search elsewhere.

CREATE TABLE IF NOT EXISTS chat_sessions (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT,
  device_type TEXT
);

CREATE TABLE IF NOT EXISTS chat_events (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  message TEXT NOT NULL,
  event_type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS chat_events_session_created_idx
ON chat_events (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS chat_events_event_type_idx
ON chat_events (event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS leads (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
  name TEXT,
  phone TEXT,
  email TEXT,
  city TEXT,
  intent TEXT,
  interested_product TEXT,
  interested_products JSONB NOT NULL DEFAULT '[]'::jsonb,
  followup_stage TEXT NOT NULL DEFAULT 'browsing',
  lead_score INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backwards-compatible upgrades for existing databases.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS interested_products JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup_stage TEXT NOT NULL DEFAULT 'browsing';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS leads_score_created_idx
ON leads (lead_score DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS leads_followup_stage_idx
ON leads (followup_stage, updated_at DESC);

CREATE TABLE IF NOT EXISTS analytics_events (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  detected_intent TEXT,
  category TEXT,
  budget_type TEXT,
  city TEXT,
  event_type TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS event_type TEXT;
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS analytics_events_category_created_idx
ON analytics_events (category, created_at DESC);

CREATE INDEX IF NOT EXISTS analytics_events_city_created_idx
ON analytics_events (city, created_at DESC);

CREATE INDEX IF NOT EXISTS analytics_events_event_type_idx
ON analytics_events (event_type, created_at DESC);
