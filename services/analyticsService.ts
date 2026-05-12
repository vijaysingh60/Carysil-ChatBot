import { getDbPool } from "@/lib/db";
import { ensureLeadSchema } from "@/services/sessionService";
import type { AnalyticsEventInput } from "@/types/lead";

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
