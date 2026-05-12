import { randomUUID } from "node:crypto";
import { getDbPool } from "@/lib/db";
import type { ChatEventType, ChatRole } from "@/types/lead";

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
}): Promise<string> {
  const sessionId = options?.sessionId || randomUUID();
  if (!(await ensureLeadSchema())) return sessionId;

  try {
    const pool = getDbPool();
    await pool.query(
      `
      INSERT INTO chat_sessions (session_id, source, device_type)
      VALUES ($1, $2, $3)
      ON CONFLICT (session_id) DO UPDATE SET
        last_active = NOW(),
        source = COALESCE(EXCLUDED.source, chat_sessions.source),
        device_type = COALESCE(EXCLUDED.device_type, chat_sessions.device_type)
      `,
      [sessionId, options?.source ?? null, options?.deviceType ?? null]
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

export async function storeChatEvent(input: {
  sessionId: string;
  role: ChatRole;
  message: string;
  eventType: ChatEventType;
  metadata?: Record<string, unknown>;
}): Promise<void> {
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
