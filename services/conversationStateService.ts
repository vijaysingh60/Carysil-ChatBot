import { getDbPool } from "@/lib/db";
import { ensureLeadSchema } from "@/services/sessionService";
import { callAIJsonCached } from "@/lib/ai";
import { hashKey } from "@/lib/cache";
import type {
  ConversationState,
  ConversationStatePatch,
} from "@/types/conversationState";

const MEMORY_SUMMARY_TOKEN_THRESHOLD = Number(
  process.env.MEMORY_SUMMARY_TOKEN_THRESHOLD || 1500
);

type Row = {
  session_id: string;
  category: string | null;
  product_type: string | null;
  budget: string | null;
  color: string | null;
  material: string | null;
  kitchen_size: string | null;
  installation_type: string | null;
  city: string | null;
  urgency: string | null;
  preferences: Record<string, unknown> | null;
  extracted_entities: Record<string, unknown> | null;
  conversation_summary: string | null;
  summary_token_estimate: number | string | null;
  last_summarized_at: string | null;
  updated_at: string;
};

function rowToState(row: Row): ConversationState {
  return {
    sessionId: row.session_id,
    category: row.category,
    productType: row.product_type,
    budget: row.budget,
    color: row.color,
    material: row.material,
    kitchenSize: row.kitchen_size,
    installationType: row.installation_type,
    city: row.city,
    urgency: row.urgency,
    preferences: row.preferences ?? {},
    extractedEntities: row.extracted_entities ?? {},
    conversationSummary: row.conversation_summary,
    summaryTokenEstimate: Number(row.summary_token_estimate ?? 0),
    lastSummarizedAt: row.last_summarized_at,
    updatedAt: row.updated_at,
  };
}

/** Returns null if no memory row exists yet for the session. */
export async function getConversationState(
  sessionId: string
): Promise<ConversationState | null> {
  if (!(await ensureLeadSchema())) return null;
  try {
    const pool = getDbPool();
    const { rows } = await pool.query<Row>(
      `SELECT session_id, category, product_type, budget, color, material,
              kitchen_size, installation_type, city, urgency,
              preferences, extracted_entities, conversation_summary,
              summary_token_estimate, last_summarized_at, updated_at
       FROM conversation_state WHERE session_id = $1 LIMIT 1`,
      [sessionId]
    );
    if (rows.length === 0) return null;
    return rowToState(rows[0]);
  } catch (error) {
    console.error("[memory] getConversationState failed", error);
    return null;
  }
}

/**
 * COALESCE-merge a patch into the conversation_state row. The SQL is written
 * so a NULL field on the patch *never* overwrites an existing valid value;
 * preferences and extracted_entities are merged with the JSONB || operator.
 * Returns the resulting row (or null if the write failed).
 */
export async function updateConversationState(
  sessionId: string,
  patch: ConversationStatePatch
): Promise<ConversationState | null> {
  if (!(await ensureLeadSchema())) return null;
  const preferences = patch.preferences ?? {};
  const extractedEntities = patch.extractedEntities ?? {};
  try {
    const pool = getDbPool();
    const { rows } = await pool.query<Row>(
      `
      INSERT INTO conversation_state (
        session_id, category, product_type, budget, color, material,
        kitchen_size, installation_type, city, urgency,
        preferences, extracted_entities, conversation_summary, summary_token_estimate, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11::jsonb, $12::jsonb, $13, COALESCE($14, 0), NOW()
      )
      ON CONFLICT (session_id) DO UPDATE SET
        category           = COALESCE(EXCLUDED.category,           conversation_state.category),
        product_type       = COALESCE(EXCLUDED.product_type,       conversation_state.product_type),
        budget             = COALESCE(EXCLUDED.budget,             conversation_state.budget),
        color              = COALESCE(EXCLUDED.color,              conversation_state.color),
        material           = COALESCE(EXCLUDED.material,           conversation_state.material),
        kitchen_size       = COALESCE(EXCLUDED.kitchen_size,       conversation_state.kitchen_size),
        installation_type  = COALESCE(EXCLUDED.installation_type,  conversation_state.installation_type),
        city               = COALESCE(EXCLUDED.city,               conversation_state.city),
        urgency            = COALESCE(EXCLUDED.urgency,            conversation_state.urgency),
        preferences        = conversation_state.preferences || EXCLUDED.preferences,
        extracted_entities = conversation_state.extracted_entities || EXCLUDED.extracted_entities,
        conversation_summary    = COALESCE(EXCLUDED.conversation_summary,    conversation_state.conversation_summary),
        summary_token_estimate  = COALESCE(NULLIF(EXCLUDED.summary_token_estimate, 0), conversation_state.summary_token_estimate),
        updated_at = NOW()
      RETURNING session_id, category, product_type, budget, color, material,
                kitchen_size, installation_type, city, urgency,
                preferences, extracted_entities, conversation_summary,
                summary_token_estimate, last_summarized_at, updated_at
      `,
      [
        sessionId,
        patch.category ?? null,
        patch.productType ?? null,
        patch.budget ?? null,
        patch.color ?? null,
        patch.material ?? null,
        patch.kitchenSize ?? null,
        patch.installationType ?? null,
        patch.city ?? null,
        patch.urgency ?? null,
        JSON.stringify(preferences),
        JSON.stringify(extractedEntities),
        patch.conversationSummary ?? null,
        typeof patch.summaryTokenEstimate === "number" ? patch.summaryTokenEstimate : null,
      ]
    );
    return rows[0] ? rowToState(rows[0]) : null;
  } catch (error) {
    console.error("[memory] updateConversationState failed", error);
    return null;
  }
}

const ENTITY_EXTRACTION_SYSTEM = `You are AskCary's entity extractor for a kitchen/bath conversational concierge.
Read the latest user message plus the prior structured slots and return a strict JSON object with any new or refined slot values.

Schema:
{
  "category": "Sink" | "Faucet" | "Disposer" | "Hob" | "Chimney" | "Dishwasher" | "Combo" | "Accessory" | null,
  "product_type": string | null,
  "budget": "budget" | "mid" | "high" | string | null,
  "color": string | null,
  "material": string | null,
  "kitchen_size": "compact" | "medium" | "large" | string | null,
  "installation_type": "topmount" | "undermount" | "deck" | "wall" | string | null,
  "city": string | null,
  "urgency": "low" | "medium" | "high" | null,
  "preferences": object,
  "intent_confidence": number,
  "buying_confidence": number
}

Rules:
1. Return ONLY fields you are confident about. Use null for unknown / unchanged fields.
2. Never replace a previously known value with null in your output.
3. intent_confidence and buying_confidence must be floats between 0 and 1.
4. "preferences" can hold extras (e.g. {"bowl":"double","spout":"pull-out"}).`;

type EntityExtractionResult = ConversationStatePatch & {
  intentConfidence?: number;
  buyingConfidence?: number;
};

type RawExtraction = {
  category?: string | null;
  product_type?: string | null;
  budget?: string | null;
  color?: string | null;
  material?: string | null;
  kitchen_size?: string | null;
  installation_type?: string | null;
  city?: string | null;
  urgency?: string | null;
  preferences?: Record<string, unknown>;
  intent_confidence?: number;
  buying_confidence?: number;
};

function clamp01(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return Number(value.toFixed(3));
}

function stripNulls(input: RawExtraction): EntityExtractionResult {
  const out: EntityExtractionResult = {};
  if (input.category) out.category = input.category;
  if (input.product_type) out.productType = input.product_type;
  if (input.budget) out.budget = input.budget;
  if (input.color) out.color = input.color;
  if (input.material) out.material = input.material;
  if (input.kitchen_size) out.kitchenSize = input.kitchen_size;
  if (input.installation_type) out.installationType = input.installation_type;
  if (input.city) out.city = input.city;
  if (input.urgency) out.urgency = input.urgency;
  if (input.preferences && typeof input.preferences === "object") {
    out.preferences = input.preferences;
  }
  const intentConfidence = clamp01(input.intent_confidence);
  if (intentConfidence !== undefined) out.intentConfidence = intentConfidence;
  const buyingConfidence = clamp01(input.buying_confidence);
  if (buyingConfidence !== undefined) out.buyingConfidence = buyingConfidence;
  return out;
}

/**
 * LLM-driven slot extractor. Falls back to an empty patch (so the SQL merge is
 * a no-op) when there is no API key, the call fails, or JSON parsing breaks.
 */
export async function extractStructuredEntities(
  message: string,
  history: Array<{ role: string; content: string }>,
  prior: ConversationState | null
): Promise<EntityExtractionResult> {
  const recent = history.slice(-6);
  const priorSlots = prior
    ? {
        category: prior.category,
        product_type: prior.productType,
        budget: prior.budget,
        color: prior.color,
        material: prior.material,
        kitchen_size: prior.kitchenSize,
        installation_type: prior.installationType,
        city: prior.city,
        urgency: prior.urgency,
        preferences: prior.preferences,
      }
    : null;
  const userContent =
    `Existing slots:\n${JSON.stringify(priorSlots, null, 2)}\n\n` +
    `Recent conversation:\n${recent
      .map((entry) => `${entry.role === "user" ? "User" : "AskCary"}: ${entry.content}`)
      .join("\n")}\n\n` +
    `Latest user message:\n${message}\n\n` +
    `Return strict JSON.`;

  const fallback: RawExtraction = {};
  const cacheKey = hashKey(`entities|${prior?.sessionId ?? ""}|${message}`);
  const { data } = await callAIJsonCached<RawExtraction>(
    ENTITY_EXTRACTION_SYSTEM,
    userContent,
    fallback,
    cacheKey
  );
  return stripNulls(data ?? {});
}

const SUMMARY_SYSTEM = `You are AskCary's conversation summarizer. Compress the conversation into ONE short sentence
(maximum 30 words) capturing the user's needs, preferred product type, key constraints (budget, color,
material, size), and city if known. Example: "User wants a premium black quartz sink for compact kitchen under Rs 8,000 in Pune."

Return JSON of shape {"summary": "..."}.`;

type SummaryPayload = { summary?: string };

function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Generates a compact 1-sentence semantic summary of the session and persists it.
 * Returns the summary text (or null if no summary could be produced).
 */
export async function generateConversationSummary(
  sessionId: string,
  history: Array<{ role: string; content: string }>
): Promise<string | null> {
  if (history.length === 0) return null;
  const transcript = history
    .slice(-20)
    .map((entry) => `${entry.role === "user" ? "User" : "AskCary"}: ${entry.content}`)
    .join("\n");

  const fallback: SummaryPayload = {};
  const cacheKey = hashKey(`summary|${sessionId}|${history.length}`);
  const { data } = await callAIJsonCached<SummaryPayload>(
    SUMMARY_SYSTEM,
    transcript,
    fallback,
    cacheKey
  );
  const summary = (data?.summary ?? "").toString().trim();
  if (!summary) return null;

  const tokenEstimate = approximateTokens(transcript);
  await updateConversationState(sessionId, {
    conversationSummary: summary,
    summaryTokenEstimate: tokenEstimate,
  });
  // Stamp last_summarized_at separately since updateConversationState merges only the summary text.
  if (await ensureLeadSchema()) {
    try {
      await getDbPool().query(
        `UPDATE conversation_state SET last_summarized_at = NOW() WHERE session_id = $1`,
        [sessionId]
      );
    } catch (error) {
      console.error("[memory] failed to stamp last_summarized_at", error);
    }
  }
  return summary;
}

/** True when the running transcript hit the message or token threshold. */
export function shouldSummarize(
  history: Array<{ role: string; content: string }>,
  prior: ConversationState | null
): boolean {
  if (history.length === 0) return false;
  if (history.length > 0 && history.length % 10 === 0) return true;
  const tokens = history.reduce((sum, entry) => sum + approximateTokens(entry.content), 0);
  if (tokens > MEMORY_SUMMARY_TOKEN_THRESHOLD) {
    // Don't re-summarize within the same window if a fresh summary already exists.
    if (!prior?.lastSummarizedAt) return true;
    const lastTs = new Date(prior.lastSummarizedAt).getTime();
    return Number.isFinite(lastTs) && Date.now() - lastTs > 5 * 60_000;
  }
  return false;
}

/**
 * Convenience wrapper: extract entities, merge, and trigger summarization when
 * appropriate. Designed to be called from the concierge route after the
 * `user_message` is logged but before intent detection.
 */
export async function ingestUserTurn(
  sessionId: string,
  message: string,
  history: Array<{ role: string; content: string }>
): Promise<{ memory: ConversationState | null; extraction: EntityExtractionResult }> {
  const prior = await getConversationState(sessionId);
  const extraction = await extractStructuredEntities(message, history, prior);
  let memory: ConversationState | null = prior;
  if (
    extraction.category ||
    extraction.productType ||
    extraction.budget ||
    extraction.color ||
    extraction.material ||
    extraction.kitchenSize ||
    extraction.installationType ||
    extraction.city ||
    extraction.urgency ||
    (extraction.preferences && Object.keys(extraction.preferences).length > 0)
  ) {
    memory = (await updateConversationState(sessionId, extraction)) ?? prior;
  }
  if (shouldSummarize(history, memory)) {
    // Fire-and-forget summary; never block the request path on it.
    void generateConversationSummary(sessionId, history);
  }
  return { memory, extraction };
}
