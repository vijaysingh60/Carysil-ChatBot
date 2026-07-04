-- Carysil AskCary — Conversation memory: user name + buying stage (additive, idempotent)
--
-- Lets the conversation analyzer persist the shopper's name and buying stage
-- independent of full lead capture (phone/email), so the assistant can greet
-- a user by name without gating that on contact info. Mirrors the bootstrap
-- pattern in services/sessionService.ts (CREATE_FIN_UPGRADE_SQL).
--
-- Safe to re-run.

ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS user_name TEXT;
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS buying_stage TEXT;
