/**
 * Structured, single-line-per-request logging for the RAG pipeline.
 *
 * Before this, failures were debuggable only via scattered `console.error`
 * calls with no shared shape and no way to tell, from a failed answer,
 * which stage broke: retrieval returning nothing, grounding rejecting the
 * LLM's draft, or the LLM just answering badly. This gives every
 * product-recommendation turn one structured record covering
 * retrieval -> context -> generation -> citations -> latency, so a bad
 * answer can be traced back to its retrieved candidates and scores instead
 * of re-run blind.
 *
 * Deliberately console-based (not a new DB table) — this is a debugging aid,
 * not an analytics feature (see services/analyticsService.ts /
 * services/recommendationAnalyticsService.ts for the latter). Never logs
 * contact info (name/phone/email) — only the product query and retrieval
 * shape.
 */

export type RagEvent = {
  stage: "product_recommendation" | "installation_support" | "architect_assistant";
  sessionId: string;
  query: string;
  retrieved: Array<{ id: string; similarity: number }>;
  contextItemCount: number;
  answerPreview: string;
  citations: string[];
  groundingIssues: string[];
  aiUsed: boolean;
  model: string;
  embeddingModel: string;
  latencyMs: number;
};

export function logRagEvent(event: RagEvent): void {
  const record = {
    ts: new Date().toISOString(),
    stage: event.stage,
    sessionId: event.sessionId,
    query: event.query,
    retrieved: event.retrieved.map((r) => ({ id: r.id, score: Number(r.similarity.toFixed(4)) })),
    context_items: event.contextItemCount,
    answer_preview: event.answerPreview.slice(0, 160),
    citations: event.citations,
    grounding_issues: event.groundingIssues,
    ai_used: event.aiUsed,
    model: event.model,
    embedding_model: event.embeddingModel,
    latency_ms: event.latencyMs,
    zero_retrieval: event.retrieved.length === 0,
    zero_citations: event.citations.length === 0,
  };
  console.log(`[rag:${event.stage}]`, JSON.stringify(record));
}
