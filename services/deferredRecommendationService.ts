import { getDbPool } from "@/lib/db";
import { ensureLeadSchema, storeChatEvent } from "@/services/sessionService";

const EVENT_TYPE = "recommendations_deferred";

export async function getDeferredProductQuery(sessionId: string): Promise<string | null> {
  if (!(await ensureLeadSchema())) return null;
  try {
    const pool = getDbPool();
    const res = await pool.query<{ metadata: { userQuery?: string } }>(
      `
      SELECT metadata
      FROM chat_events
      WHERE session_id = $1 AND event_type = $2
      ORDER BY id DESC
      LIMIT 1
      `,
      [sessionId, EVENT_TYPE]
    );
    const q = res.rows[0]?.metadata?.userQuery;
    return typeof q === "string" && q.trim() ? q.trim() : null;
  } catch (e) {
    console.error("[deferred] getDeferredProductQuery failed", e);
    return null;
  }
}

export async function setDeferredProductQuery(sessionId: string, userQuery: string): Promise<void> {
  if (!(await ensureLeadSchema())) return;
  try {
    const pool = getDbPool();
    await pool.query(`DELETE FROM chat_events WHERE session_id = $1 AND event_type = $2`, [
      sessionId,
      EVENT_TYPE,
    ]);
    await storeChatEvent({
      sessionId,
      role: "system",
      message: "Product recommendations deferred until contact",
      eventType: EVENT_TYPE,
      metadata: { userQuery: userQuery.trim() },
    });
  } catch (e) {
    console.error("[deferred] setDeferredProductQuery failed", e);
  }
}

export async function clearDeferredProductQuery(sessionId: string): Promise<void> {
  if (!(await ensureLeadSchema())) return;
  try {
    const pool = getDbPool();
    await pool.query(`DELETE FROM chat_events WHERE session_id = $1 AND event_type = $2`, [
      sessionId,
      EVENT_TYPE,
    ]);
  } catch (e) {
    console.error("[deferred] clearDeferredProductQuery failed", e);
  }
}
