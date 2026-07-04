import { getDbPool } from "@/lib/db";
import { ensureLeadSchema } from "@/services/sessionService";
import { enqueue, registerHandler } from "@/lib/eventBus";
import type {
  RecommendationEventInput,
  RecommendationEventType,
} from "@/types/recommendationEvent";

/**
 * Recommendation analytics: structured impression / click / conversion log
 * keyed on (session_id, product_id). Decouples conversion analytics from
 * `chat_events.metadata` text mining.
 *
 * Writes flow through the event bus (Part H) so a single recommendation turn
 * batches all `retrieved` + `shown` rows into one INSERT.
 */

const REC_QUEUE = "recommendation_event";

let handlerRegistered = false;

function ensureRecHandler(): void {
  if (handlerRegistered) return;
  registerHandler<RecommendationEventInput>(REC_QUEUE, async (batch) => {
    if (!(await ensureLeadSchema())) return;
    if (batch.length === 0) return;
    const pool = getDbPool();
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
        item.productId,
        item.eventType,
        item.retrievalRank ?? null,
        item.similarity ?? null,
        item.eventType === "clicked",
        item.eventType === "converted",
        JSON.stringify(item.metadata ?? {})
      );
    }
    try {
      await pool.query(
        `INSERT INTO recommendation_events (session_id, product_id, event_type, retrieval_rank, similarity, clicked, converted, metadata) VALUES ${values.join(", ")}`,
        params
      );
    } catch (err: unknown) {
      // FK violation (23503): product_id not yet in `products` table — skip, don't crash.
      if ((err as { code?: string }).code === "23503") {
        console.warn("[rec-analytics] skipped insert — product_id FK violation (products table not seeded)");
      } else {
        throw err;
      }
    }
  });
  handlerRegistered = true;
}

function logEventAsync(input: RecommendationEventInput, dedupeWindowKey?: string): void {
  ensureRecHandler();
  const dedupeKey =
    dedupeWindowKey ??
    `${input.sessionId}|${input.productId}|${input.eventType}`;
  enqueue(REC_QUEUE, input, { dedupeKey });
}

export type RetrievedProduct = {
  id: string;
  similarity?: number | null;
};

export function logRetrieval(
  sessionId: string,
  products: RetrievedProduct[],
  query: string
): void {
  products.forEach((product, index) => {
    if (!product.id) return;
    logEventAsync({
      sessionId,
      productId: product.id,
      eventType: "retrieved",
      retrievalRank: index + 1,
      similarity: typeof product.similarity === "number" ? product.similarity : null,
      metadata: { query: query.slice(0, 200) },
    });
  });
}

export function logShown(
  sessionId: string,
  shownProductIds: string[],
  metadata?: Record<string, unknown>
): void {
  shownProductIds.forEach((productId, index) => {
    if (!productId) return;
    logEventAsync({
      sessionId,
      productId,
      eventType: "shown",
      retrievalRank: index + 1,
      metadata: metadata ?? {},
    });
  });
}

export function logClick(sessionId: string, productId: string, metadata?: Record<string, unknown>): void {
  logEventAsync({
    sessionId,
    productId,
    eventType: "clicked",
    metadata: metadata ?? {},
  });
}

export function logConversion(
  sessionId: string,
  productId: string,
  metadata?: Record<string, unknown>
): void {
  logEventAsync({
    sessionId,
    productId,
    eventType: "converted",
    metadata: metadata ?? {},
  });
}

/**
 * Logs a 'refined' row per product the refinement was made against. product_id
 * has a hard FK to `products`, so — unlike the other event types — this can't
 * use a synthetic session-level id; it needs real product ids in play this
 * turn (e.g. the newly retrieved set for the refined query).
 */
export function logRefinement(
  sessionId: string,
  productIds: string[],
  query: string,
  previousQuery?: string | null
): void {
  const metadata = {
    query: query.slice(0, 200),
    previousQuery: previousQuery ? previousQuery.slice(0, 200) : null,
  };
  productIds.forEach((productId) => {
    if (!productId) return;
    logEventAsync(
      { sessionId, productId, eventType: "refined", metadata },
      `${sessionId}|${productId}|refined|${query.slice(0, 80)}`
    );
  });
}

/** Mark every retrieved-but-not-shown product as 'ignored' for a session. */
export async function logIgnoredProducts(sessionId: string): Promise<void> {
  if (!(await ensureLeadSchema())) return;
  try {
    const pool = getDbPool();
    await pool.query(
      `
      INSERT INTO recommendation_events (session_id, product_id, event_type, retrieval_rank, metadata)
      SELECT DISTINCT r.session_id, r.product_id, 'ignored', r.retrieval_rank, '{}'::jsonb
      FROM recommendation_events r
      WHERE r.session_id = $1 AND r.event_type = 'retrieved'
        AND NOT EXISTS (
          SELECT 1 FROM recommendation_events s
          WHERE s.session_id = r.session_id AND s.product_id = r.product_id
            AND s.event_type IN ('shown','clicked','converted','ignored')
        )
      `,
      [sessionId]
    );
  } catch (error) {
    console.error("[analytics] logIgnoredProducts failed", error);
  }
}

export const RECOMMENDATION_EVENT_TYPES: RecommendationEventType[] = [
  "retrieved",
  "shown",
  "clicked",
  "ignored",
  "refined",
  "converted",
];
