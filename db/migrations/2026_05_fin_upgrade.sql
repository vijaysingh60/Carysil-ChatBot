-- Carysil AskCary — Fin-grade upgrade migration (additive, idempotent)
--
-- Adds: conversation_state, recommendation_events, lead_signals,
--       funnel_transitions, visitors, persons.
-- Extends: chat_sessions (visitor_id, person_id) and leads (lead_tier,
--          lead_priority, intent_confidence, buying_confidence,
--          last_engagement_at, last_decay_at, funnel_stage).
--
-- Safe to re-run. All statements use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS
-- so this file matches the existing bootstrap pattern in services/sessionService.ts.

-- ----------------------------------------------------------------------------
-- 1. Identity model: visitors and persons
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS persons (
  id BIGSERIAL PRIMARY KEY,
  phone_hash TEXT UNIQUE,
  email_hash TEXT UNIQUE,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lifetime_lead_score INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS visitors (
  visitor_id TEXT PRIMARY KEY,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sessions_count INTEGER NOT NULL DEFAULT 1,
  person_id BIGINT REFERENCES persons(id) ON DELETE SET NULL,
  device_fingerprint JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS visitors_person_idx ON visitors (person_id);
CREATE INDEX IF NOT EXISTS visitors_last_seen_idx ON visitors (last_seen DESC);

ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS visitor_id TEXT;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS person_id BIGINT;

CREATE INDEX IF NOT EXISTS chat_sessions_visitor_idx ON chat_sessions (visitor_id);
CREATE INDEX IF NOT EXISTS chat_sessions_person_idx ON chat_sessions (person_id);

-- ----------------------------------------------------------------------------
-- 2. Structured conversational memory
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS conversation_state (
  session_id TEXT PRIMARY KEY REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
  category TEXT,
  product_type TEXT,
  budget TEXT,
  color TEXT,
  material TEXT,
  kitchen_size TEXT,
  installation_type TEXT,
  city TEXT,
  urgency TEXT,
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  extracted_entities JSONB NOT NULL DEFAULT '{}'::jsonb,
  conversation_summary TEXT,
  summary_token_estimate INTEGER NOT NULL DEFAULT 0,
  last_summarized_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS conversation_state_updated_idx ON conversation_state (updated_at DESC);
CREATE INDEX IF NOT EXISTS conversation_state_category_idx ON conversation_state (category);

-- ----------------------------------------------------------------------------
-- 3. Recommendation analytics (impressions, clicks, conversions)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS recommendation_events (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('retrieved','shown','clicked','ignored','refined','converted')),
  retrieval_rank INTEGER,
  similarity NUMERIC(6,4),
  clicked BOOLEAN NOT NULL DEFAULT FALSE,
  converted BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rec_events_session_created_idx
  ON recommendation_events (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rec_events_product_type_idx
  ON recommendation_events (product_id, event_type);
CREATE INDEX IF NOT EXISTS rec_events_type_created_idx
  ON recommendation_events (event_type, created_at DESC);

-- ----------------------------------------------------------------------------
-- 4. Behavioral lead signals (replaces static cumulative scoring)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lead_signals (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
  signal_type TEXT NOT NULL,
  weight NUMERIC(6,2) NOT NULL DEFAULT 0,
  decayed_weight NUMERIC(6,2) NOT NULL DEFAULT 0,
  source TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS lead_signals_session_created_idx
  ON lead_signals (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lead_signals_type_idx
  ON lead_signals (signal_type);

-- Idempotent backfill for lead_signals tables created before decayed_weight existed.
ALTER TABLE lead_signals ADD COLUMN IF NOT EXISTS decayed_weight NUMERIC(6,2) NOT NULL DEFAULT 0;

-- ----------------------------------------------------------------------------
-- 5. Funnel intelligence
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS funnel_transitions (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS funnel_transitions_session_idx
  ON funnel_transitions (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS funnel_transitions_stage_idx
  ON funnel_transitions (to_stage, created_at DESC);

-- ----------------------------------------------------------------------------
-- 6. Leads extensions (tiers, confidence, decay, funnel stage)
-- ----------------------------------------------------------------------------

ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_tier TEXT NOT NULL DEFAULT 'cold';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_priority NUMERIC(6,3) NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS intent_confidence NUMERIC(4,3);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS buying_confidence NUMERIC(4,3);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_engagement_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_decay_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS funnel_stage TEXT NOT NULL DEFAULT 'awareness';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS person_id BIGINT;

CREATE INDEX IF NOT EXISTS leads_tier_idx ON leads (lead_tier);
CREATE INDEX IF NOT EXISTS leads_funnel_idx ON leads (funnel_stage);
CREATE INDEX IF NOT EXISTS leads_priority_idx ON leads (lead_priority DESC);
CREATE INDEX IF NOT EXISTS leads_last_engagement_idx ON leads (last_engagement_at DESC);
CREATE INDEX IF NOT EXISTS leads_person_idx ON leads (person_id);

-- Partial index speeds up the dashboard's typed-event filters.
CREATE INDEX IF NOT EXISTS analytics_events_typed_session_idx
  ON analytics_events (session_id, event_type)
  WHERE event_type IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 7. Dashboard convenience views (lightweight; not materialized)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_best_converting_products AS
SELECT
  product_id,
  COUNT(*) FILTER (WHERE event_type = 'shown')      AS impressions,
  COUNT(*) FILTER (WHERE event_type = 'clicked')    AS clicks,
  COUNT(*) FILTER (WHERE event_type = 'converted')  AS conversions,
  CASE
    WHEN COUNT(*) FILTER (WHERE event_type = 'shown') > 0
    THEN ROUND(
      COUNT(*) FILTER (WHERE event_type = 'clicked')::numeric
      / NULLIF(COUNT(*) FILTER (WHERE event_type = 'shown'), 0)
    , 4)
    ELSE 0
  END AS ctr
FROM recommendation_events
GROUP BY product_id
ORDER BY conversions DESC, clicks DESC, impressions DESC;

CREATE OR REPLACE VIEW v_ignored_products AS
SELECT
  product_id,
  COUNT(*) FILTER (WHERE event_type = 'retrieved') AS retrievals,
  COUNT(*) FILTER (WHERE event_type = 'shown')     AS impressions,
  COUNT(*) FILTER (WHERE event_type = 'clicked')   AS clicks
FROM recommendation_events
GROUP BY product_id
HAVING COUNT(*) FILTER (WHERE event_type = 'shown') = 0
   AND COUNT(*) FILTER (WHERE event_type = 'clicked') = 0
ORDER BY retrievals DESC;

CREATE OR REPLACE VIEW v_failed_recommendations AS
SELECT
  product_id,
  COUNT(*) FILTER (WHERE event_type = 'shown') AS impressions_last_7d
FROM recommendation_events
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY product_id
HAVING COUNT(*) FILTER (WHERE event_type = 'shown') > 0
   AND COUNT(*) FILTER (WHERE event_type = 'clicked') = 0
ORDER BY impressions_last_7d DESC;

CREATE OR REPLACE VIEW v_top_refined_searches AS
SELECT
  session_id,
  COUNT(*) AS refinements,
  MAX(created_at) AS last_refined_at
FROM recommendation_events
WHERE event_type = 'refined'
GROUP BY session_id
ORDER BY refinements DESC;

CREATE OR REPLACE VIEW v_lead_converting_products AS
SELECT
  re.product_id,
  l.lead_tier,
  COUNT(DISTINCT re.session_id) AS sessions,
  COUNT(*) FILTER (WHERE re.event_type = 'clicked') AS clicks,
  COUNT(*) FILTER (WHERE re.event_type = 'converted') AS conversions
FROM recommendation_events re
JOIN leads l ON l.session_id = re.session_id
GROUP BY re.product_id, l.lead_tier
ORDER BY conversions DESC, clicks DESC;

CREATE OR REPLACE VIEW v_funnel_distribution AS
SELECT funnel_stage, COUNT(*) AS sessions
FROM leads
GROUP BY funnel_stage
ORDER BY sessions DESC;
