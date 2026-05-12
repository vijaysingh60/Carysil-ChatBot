import { randomUUID } from "node:crypto";
import { getDbPool } from "@/lib/db";
import { enqueue, registerHandler } from "@/lib/eventBus";
import type { ChatEventType, ChatRole } from "@/types/lead";

/**
 * Fin-grade upgrade DDL appended below the base schema. Kept in this file so
 * cold-start bootstrap remains a single round-trip. The matching standalone
 * file lives at `db/migrations/2026_05_fin_upgrade.sql` for ops runs.
 */
export const CREATE_FIN_UPGRADE_SQL = `
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

CREATE INDEX IF NOT EXISTS analytics_events_typed_session_idx
  ON analytics_events (session_id, event_type)
  WHERE event_type IS NOT NULL;

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

CREATE OR REPLACE VIEW v_funnel_distribution AS
SELECT funnel_stage, COUNT(*) AS sessions
FROM leads
GROUP BY funnel_stage
ORDER BY sessions DESC;
`;

export const CREATE_LEAD_GENERATION_SCHEMA_SQL = `
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
`;

let schemaReady = false;

export async function ensureLeadSchema(): Promise<boolean> {
  if (schemaReady) return true;
  try {
    const pool = getDbPool();
    await pool.query(CREATE_LEAD_GENERATION_SCHEMA_SQL);
    // Best-effort fin-upgrade DDL. Failure here must not block the base flow.
    try {
      await pool.query(CREATE_FIN_UPGRADE_SQL);
    } catch (upgradeError) {
      console.error("[tracking] fin-upgrade DDL skipped", upgradeError);
    }
    schemaReady = true;
    return true;
  } catch (error) {
    console.error("[tracking] lead schema unavailable", error);
    return false;
  }
}

export async function createSession(options?: {
  sessionId?: string;
  source?: string;
  deviceType?: string;
  visitorId?: string;
}): Promise<string> {
  const sessionId = options?.sessionId || randomUUID();
  if (!(await ensureLeadSchema())) return sessionId;

  try {
    const pool = getDbPool();
    await pool.query(
      `
      INSERT INTO chat_sessions (session_id, source, device_type, visitor_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (session_id) DO UPDATE SET
        last_active = NOW(),
        source = COALESCE(EXCLUDED.source, chat_sessions.source),
        device_type = COALESCE(EXCLUDED.device_type, chat_sessions.device_type),
        visitor_id = COALESCE(EXCLUDED.visitor_id, chat_sessions.visitor_id)
      `,
      [
        sessionId,
        options?.source ?? null,
        options?.deviceType ?? null,
        options?.visitorId ?? null,
      ]
    );
  } catch (error) {
    console.error("[tracking] createSession failed", error);
  }

  return sessionId;
}

export async function touchSession(sessionId: string): Promise<void> {
  if (!(await ensureLeadSchema())) return;
  try {
    const pool = getDbPool();
    await pool.query("UPDATE chat_sessions SET last_active = NOW() WHERE session_id = $1", [sessionId]);
  } catch (error) {
    console.error("[tracking] touchSession failed", error);
  }
}

type ChatEventInput = {
  sessionId: string;
  role: ChatRole;
  message: string;
  eventType: ChatEventType;
  metadata?: Record<string, unknown>;
};

const CHAT_QUEUE = "chat_event";
let chatHandlerRegistered = false;

function ensureChatEventHandler(): void {
  if (chatHandlerRegistered) return;
  registerHandler<ChatEventInput>(CHAT_QUEUE, async (batch) => {
    if (!(await ensureLeadSchema())) return;
    const pool = getDbPool();
    const values: string[] = [];
    const params: unknown[] = [];
    for (let i = 0; i < batch.length; i += 1) {
      const item = batch[i];
      const base = i * 5;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb)`);
      params.push(
        item.sessionId,
        item.role,
        item.message,
        item.eventType,
        JSON.stringify(item.metadata || {})
      );
    }
    await pool.query(
      `INSERT INTO chat_events (session_id, role, message, event_type, metadata) VALUES ${values.join(", ")}`,
      params
    );
  });
  chatHandlerRegistered = true;
}

/**
 * Synchronous chat event insert. Use for the critical lead-capture path that
 * must be durable before the HTTP response returns.
 */
export async function storeChatEvent(input: ChatEventInput): Promise<void> {
  if (!(await ensureLeadSchema())) return;
  try {
    const pool = getDbPool();
    await pool.query(
      `
      INSERT INTO chat_events (session_id, role, message, event_type, metadata)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      `,
      [
        input.sessionId,
        input.role,
        input.message,
        input.eventType,
        JSON.stringify(input.metadata || {}),
      ]
    );
  } catch (error) {
    console.error("[tracking] storeChatEvent failed", error);
  }
}

/**
 * Batched, deduped variant. The event bus flushes within 250ms or on
 * `flushEventBus()`. Identical event_type + truncated message pairs inside the
 * dedupe window are dropped, killing the "duplicate spam" case.
 */
export function storeChatEventAsync(input: ChatEventInput): void {
  ensureChatEventHandler();
  const dedupeKey = `${input.sessionId}|${input.eventType}|${input.message.slice(0, 120)}`;
  enqueue(CHAT_QUEUE, input, { dedupeKey });
}
