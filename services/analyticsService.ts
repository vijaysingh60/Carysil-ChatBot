import { getDbPool } from "@/lib/db";
import { ensureLeadSchema } from "@/services/sessionService";
import { enqueue, registerHandler } from "@/lib/eventBus";
import type { AnalyticsEventInput } from "@/types/lead";

const ANALYTICS_QUEUE = "analytics_event";

let analyticsHandlerRegistered = false;

function ensureAnalyticsHandler(): void {
  if (analyticsHandlerRegistered) return;
  registerHandler<AnalyticsEventInput>(ANALYTICS_QUEUE, async (batch) => {
    if (!(await ensureLeadSchema())) return;
    const pool = getDbPool();
    // Multi-row INSERT keeps the bus efficient under burst load.
    const values: string[] = [];
    const params: unknown[] = [];
    for (let i = 0; i < batch.length; i += 1) {
      const item = batch[i];
      const base = i * 8;
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}::jsonb)`
      );
      params.push(
        item.sessionId,
        item.query,
        item.detectedIntent ?? null,
        item.category ?? null,
        item.budgetType ?? null,
        item.city ?? null,
        item.eventType ?? null,
        JSON.stringify(item.metadata ?? {})
      );
    }
    await pool.query(
      `INSERT INTO analytics_events (session_id, query, detected_intent, category, budget_type, city, event_type, metadata) VALUES ${values.join(", ")}`,
      params
    );
  });
  analyticsHandlerRegistered = true;
}

/**
 * Synchronous insert — preserved for the lead-capture path that must be durable
 * before the HTTP response returns.
 */
export async function storeAnalyticsEvent(input: AnalyticsEventInput): Promise<void> {
  if (!(await ensureLeadSchema())) return;

  try {
    const pool = getDbPool();
    await pool.query(
      `
      INSERT INTO analytics_events (
        session_id, query, detected_intent, category, budget_type, city, event_type, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      `,
      [
        input.sessionId,
        input.query,
        input.detectedIntent ?? null,
        input.category ?? null,
        input.budgetType ?? null,
        input.city ?? null,
        input.eventType ?? null,
        JSON.stringify(input.metadata ?? {}),
      ]
    );
  } catch (error) {
    console.error("[tracking] storeAnalyticsEvent failed", error);
  }
}

/**
 * Batched, deduped variant. Use this for the high-volume baseline turn and
 * recommendation-shown analytics where strict durability is not required.
 */
export function storeAnalyticsEventAsync(input: AnalyticsEventInput): void {
  ensureAnalyticsHandler();
  const dedupeKey = `${input.sessionId}|${input.eventType ?? "_"}|${(input.query ?? "").slice(0, 80)}`;
  enqueue(ANALYTICS_QUEUE, input, { dedupeKey });
}
