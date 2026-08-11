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
  user_name: string | null;
  category: string | null;
  product_type: string | null;
  budget: string | null;
  color: string | null;
  material: string | null;
  kitchen_size: string | null;
  installation_type: string | null;
  city: string | null;
  urgency: string | null;
  buying_stage: string | null;
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
    userName: row.user_name,
    category: row.category,
    productType: row.product_type,
    budget: row.budget,
    color: row.color,
    material: row.material,
    kitchenSize: row.kitchen_size,
    installationType: row.installation_type,
    city: row.city,
    urgency: row.urgency,
    buyingStage: row.buying_stage,
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
      `SELECT session_id, user_name, category, product_type, budget, color, material,
              kitchen_size, installation_type, city, urgency, buying_stage,
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
        session_id, user_name, category, product_type, budget, color, material,
        kitchen_size, installation_type, city, urgency, buying_stage,
        preferences, extracted_entities, conversation_summary, summary_token_estimate, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12,
        $13::jsonb, $14::jsonb, $15, COALESCE($16, 0), NOW()
      )
      ON CONFLICT (session_id) DO UPDATE SET
        user_name          = COALESCE(EXCLUDED.user_name,          conversation_state.user_name),
        category           = COALESCE(EXCLUDED.category,           conversation_state.category),
        product_type       = COALESCE(EXCLUDED.product_type,       conversation_state.product_type),
        budget             = COALESCE(EXCLUDED.budget,             conversation_state.budget),
        color              = COALESCE(EXCLUDED.color,              conversation_state.color),
        material           = COALESCE(EXCLUDED.material,           conversation_state.material),
        kitchen_size       = COALESCE(EXCLUDED.kitchen_size,       conversation_state.kitchen_size),
        installation_type  = COALESCE(EXCLUDED.installation_type,  conversation_state.installation_type),
        city               = COALESCE(EXCLUDED.city,               conversation_state.city),
        urgency            = COALESCE(EXCLUDED.urgency,            conversation_state.urgency),
        buying_stage       = COALESCE(EXCLUDED.buying_stage,       conversation_state.buying_stage),
        preferences        = conversation_state.preferences || EXCLUDED.preferences,
        extracted_entities = conversation_state.extracted_entities || EXCLUDED.extracted_entities,
        conversation_summary    = COALESCE(EXCLUDED.conversation_summary,    conversation_state.conversation_summary),
        summary_token_estimate  = COALESCE(NULLIF(EXCLUDED.summary_token_estimate, 0), conversation_state.summary_token_estimate),
        updated_at = NOW()
      RETURNING session_id, user_name, category, product_type, budget, color, material,
                kitchen_size, installation_type, city, urgency, buying_stage,
                preferences, extracted_entities, conversation_summary,
                summary_token_estimate, last_summarized_at, updated_at
      `,
      [
        sessionId,
        patch.userName ?? null,
        patch.category ?? null,
        patch.productType ?? null,
        patch.budget ?? null,
        patch.color ?? null,
        patch.material ?? null,
        patch.kitchenSize ?? null,
        patch.installationType ?? null,
        patch.city ?? null,
        patch.urgency ?? null,
        patch.buyingStage ?? null,
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

const ENTITY_EXTRACTION_SYSTEM = `You are AskCary's conversation analyzer for a kitchen/bath conversational concierge.
Read the latest user message plus the prior structured slots and recent conversation, then return a
strict JSON object combining (a) durable shopper slots and (b) this-turn conversational signals.

Schema:
{
  "user_name": string | null,
  "category": "Sink" | "Faucet" | "Disposer" | "Hob" | "Chimney" | "Dishwasher" | "Combo" | "Accessory" | null,
  "product_type": string | null,
  "budget": "budget" | "mid" | "high" | string | null,
  "color": string | null,
  "material": string | null,
  "kitchen_size": "compact" | "medium" | "large" | string | null,
  "installation_type": "topmount" | "undermount" | "deck" | "wall" | string | null,
  "city": string | null,
  "urgency": "low" | "medium" | "high" | null,
  "buying_stage": "browsing" | "comparing" | "ready_to_buy" | "post_purchase" | string | null,
  "preferences": object,
  "intent_confidence": number,
  "buying_confidence": number,
  "professional_query": boolean,

  "greeting": boolean,
  "farewell": boolean,
  "gratitude": boolean,
  "small_talk": boolean,
  "frustration": boolean,
  "sentiment": "positive" | "neutral" | "negative" | null,
  "dealer_request": boolean,
  "installation_request": boolean,
  "warranty_request": boolean,
  "comparison_request": boolean,
  "recommendation_request": boolean,
  "declines_refinement": boolean,
  "confidence": number
}

Rules:
1. Return ONLY durable-slot fields you are confident about. Use null for unknown / unchanged fields.
2. Never replace a previously known value with null in your output.
3. All *_confidence fields and "confidence" must be floats between 0 and 1.
4. "preferences" can hold extras not covered by a dedicated slot, e.g. {"bowl":"double","spout":"pull-out","finish":"matte black","quantity":2,"dimensions":"60x45"}.
5. "user_name" — extract from patterns like "myself Vijay", "I'm Vijay", "I am Vijay", "name is Vijay", a
   signed-off message ("- Vijay"), etc. Only a plausible human first/full name — never a product word,
   city, or generic phrase.
6. The boolean/sentiment/*_request fields describe ONLY the latest user message (this turn), not the
   whole conversation — e.g. "greeting" should be true only if THIS message opens with a greeting.
   Default booleans to false and sentiment/buying_stage to null when not clearly signaled.
7. "small_talk" is true for chit-chat with no product/dealer intent (e.g. "how's it going", "what's up").
   A message can be both a greeting AND carry product intent ("hello, looking for a sink") — set
   greeting true but small_talk false in that case, since there's a real request to act on.
8. "declines_refinement" is true when the user was just asked to narrow down a product (size, material,
   budget, bowl type, etc.) and their reply explicitly declines to specify further or accepts any option —
   e.g. "no preference", "just sinks", "just show me sinks", "anything is fine", "doesn't matter",
   "don't care", "whatever", "any one is fine", "surprise me". This is about accepting a broad/unfiltered
   result, NOT about product intent — a message can decline refinement while still naming the category
   (e.g. "just sinks" → category "Sink", declines_refinement true).
9. "professional_query" is true when the message reads like it's from an architect, interior designer,
   contractor, dealer, or other trade professional rather than a homeowner shopping for their own kitchen —
   e.g. mentions "spec sheet", "cutout dimensions", "cutout size", "load rating", "specification",
   "for a client project", "for a project", "bulk order", "CAD", "certification", "site engineer", "BOQ",
   "specifying for", "on behalf of a client". A bare product question from a homeowner ("what sizes do
   quartz sinks come in?") is NOT professional_query — only set true on a clear trade/technical signal.
   Once true, treat it as sticky for the rest of the conversation (this is folded into durable state, not
   re-asked every turn) — so still return true on later turns that continue the same technical thread even
   without repeating the trigger phrase, based on the recent conversation context provided.`;

type EntityExtractionResult = ConversationStatePatch & {
  intentConfidence?: number;
  buyingConfidence?: number;
};

export type ConversationTurnSignals = {
  greeting: boolean;
  farewell: boolean;
  gratitude: boolean;
  smallTalk: boolean;
  frustration: boolean;
  sentiment: "positive" | "neutral" | "negative" | null;
  dealerRequest: boolean;
  installationRequest: boolean;
  warrantyRequest: boolean;
  comparisonRequest: boolean;
  recommendationRequest: boolean;
  declinesRefinement: boolean;
  confidence: number | null;
};

const EMPTY_TURN_SIGNALS: ConversationTurnSignals = {
  greeting: false,
  farewell: false,
  gratitude: false,
  smallTalk: false,
  frustration: false,
  sentiment: null,
  dealerRequest: false,
  installationRequest: false,
  warrantyRequest: false,
  comparisonRequest: false,
  recommendationRequest: false,
  declinesRefinement: false,
  confidence: null,
};

type RawExtraction = {
  user_name?: string | null;
  category?: string | null;
  product_type?: string | null;
  budget?: string | null;
  color?: string | null;
  material?: string | null;
  kitchen_size?: string | null;
  installation_type?: string | null;
  city?: string | null;
  urgency?: string | null;
  buying_stage?: string | null;
  preferences?: Record<string, unknown>;
  intent_confidence?: number;
  buying_confidence?: number;
  professional_query?: boolean;

  greeting?: boolean;
  farewell?: boolean;
  gratitude?: boolean;
  small_talk?: boolean;
  frustration?: boolean;
  sentiment?: "positive" | "neutral" | "negative" | null;
  dealer_request?: boolean;
  installation_request?: boolean;
  warranty_request?: boolean;
  comparison_request?: boolean;
  recommendation_request?: boolean;
  declines_refinement?: boolean;
  confidence?: number;
};

/**
 * "professional" is sticky for the session once detected — an architect asking a
 * follow-up product question shouldn't have to repeat trade language every turn.
 * Resolved in code (not left to the model to re-derive from context each call)
 * for the same reason the clarification-attempt counter is explicit state rather
 * than re-inferred per message: re-derivation is where these signals silently drop.
 */
function resolvePersona(raw: RawExtraction, prior: ConversationState | null): "professional" | null {
  const priorPersona = (prior?.preferences as { persona?: string } | undefined)?.persona;
  if (priorPersona === "professional" || raw.professional_query) return "professional";
  return null;
}

function clamp01(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return Number(value.toFixed(3));
}

function stripNulls(input: RawExtraction): EntityExtractionResult {
  const out: EntityExtractionResult = {};
  if (input.user_name) out.userName = input.user_name;
  if (input.category) out.category = input.category;
  if (input.product_type) out.productType = input.product_type;
  if (input.budget) out.budget = input.budget;
  if (input.color) out.color = input.color;
  if (input.material) out.material = input.material;
  if (input.kitchen_size) out.kitchenSize = input.kitchen_size;
  if (input.installation_type) out.installationType = input.installation_type;
  if (input.city) out.city = input.city;
  if (input.urgency) out.urgency = input.urgency;
  if (input.buying_stage) out.buyingStage = input.buying_stage;
  if (input.preferences && typeof input.preferences === "object") {
    out.preferences = input.preferences;
  }
  const intentConfidence = clamp01(input.intent_confidence);
  if (intentConfidence !== undefined) out.intentConfidence = intentConfidence;
  const buyingConfidence = clamp01(input.buying_confidence);
  if (buyingConfidence !== undefined) out.buyingConfidence = buyingConfidence;
  return out;
}

function extractTurnSignals(input: RawExtraction): ConversationTurnSignals {
  return {
    greeting: Boolean(input.greeting),
    farewell: Boolean(input.farewell),
    gratitude: Boolean(input.gratitude),
    smallTalk: Boolean(input.small_talk),
    frustration: Boolean(input.frustration),
    sentiment: input.sentiment ?? null,
    dealerRequest: Boolean(input.dealer_request),
    installationRequest: Boolean(input.installation_request),
    warrantyRequest: Boolean(input.warranty_request),
    comparisonRequest: Boolean(input.comparison_request),
    recommendationRequest: Boolean(input.recommendation_request),
    declinesRefinement: Boolean(input.declines_refinement),
    confidence: clamp01(input.confidence) ?? null,
  };
}

/**
 * LLM-driven conversation analyzer. Returns durable slot updates (merged into
 * `conversation_state`) plus this-turn-only signals (greeting/sentiment/social
 * cues/request flags) used purely for routing the current response — callers
 * must not persist `turnSignals` as memory. Falls back to an empty patch and
 * neutral signals when there is no API key, the call fails, or JSON parsing
 * breaks.
 */
export async function extractStructuredEntities(
  message: string,
  history: Array<{ role: string; content: string }>,
  prior: ConversationState | null
): Promise<EntityExtractionResult & { turnSignals: ConversationTurnSignals }> {
  const recent = history.slice(-6);
  const priorSlots = prior
    ? {
        user_name: prior.userName,
        category: prior.category,
        product_type: prior.productType,
        budget: prior.budget,
        color: prior.color,
        material: prior.material,
        kitchen_size: prior.kitchenSize,
        installation_type: prior.installationType,
        city: prior.city,
        urgency: prior.urgency,
        buying_stage: prior.buyingStage,
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
  const raw = data ?? {};
  const extraction = stripNulls(raw);
  const persona = resolvePersona(raw, prior);
  if (persona) {
    extraction.preferences = { ...(extraction.preferences ?? {}), persona };
  }
  return { ...extraction, turnSignals: data ? extractTurnSignals(raw) : EMPTY_TURN_SIGNALS };
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
): Promise<{
  memory: ConversationState | null;
  extraction: EntityExtractionResult & { turnSignals: ConversationTurnSignals };
}> {
  const prior = await getConversationState(sessionId);
  const extraction = await extractStructuredEntities(message, history, prior);
  let memory: ConversationState | null = prior;
  if (
    extraction.userName ||
    extraction.category ||
    extraction.productType ||
    extraction.budget ||
    extraction.color ||
    extraction.material ||
    extraction.kitchenSize ||
    extraction.installationType ||
    extraction.city ||
    extraction.urgency ||
    extraction.buyingStage ||
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
