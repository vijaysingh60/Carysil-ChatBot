import { callAIJsonCached } from "@/lib/ai";
import { hashKey } from "@/lib/cache";
import {
  CONVERSATION_SLOTS,
  PLANNER_SLOT_PRIORITY,
  type ConversationState,
  type ConversationStateSlot,
} from "@/types/conversationState";
import type { FunnelStage } from "@/types/funnel";
import type { RecommendationFollowupReason } from "@/types/recommendationEvent";
import type { IntentResult } from "@/lib/concierge";
import type { DetectedSalesIntent, FollowupStage } from "@/types/lead";
import type {
  ConversationMessage,
  RecommendationLite,
} from "@/lib/followupEngine";

/**
 * LLM-driven follow-up planner.
 *
 * Replaces the rules-based question chooser in {@link generateFollowupQuestion}
 * when the `ENABLE_AI_FOLLOWUP` feature flag is on. The rules engine remains
 * the fallback when either:
 *   - the flag is off,
 *   - the LLM call fails / no API key,
 *   - the LLM returns an empty payload or asks for an already-known slot.
 *
 * Output is always a single focused question with a typed `reason` so the
 * dashboard can measure follow-up effectiveness per reason.
 */

export type FollowupPlannerAction =
  | "ask"
  | "recommend"
  | "capture_lead"
  | "show_dealer"
  | "none";

export type FollowupPlannerInput = {
  sessionId: string;
  state: ConversationState | null;
  summary: string | null;
  recentMessages: ConversationMessage[];
  recommendationsShown: RecommendationLite[];
  leadStage: FollowupStage;
  funnelStage: FunnelStage | null;
  intent: IntentResult;
  salesIntent: DetectedSalesIntent;
  hasContact: boolean;
};

export type FollowupPlannerOutput = {
  action: FollowupPlannerAction;
  question: string | null;
  reason: RecommendationFollowupReason;
  targetSlot: ConversationStateSlot | null;
  aiUsed: boolean;
};

const FOLLOWUP_SYSTEM = `You are AskCary's follow-up planner. You decide the next conversational move for a kitchen / bath shopping concierge.

Inputs (provided in the user message):
- "memory": already-known slot values (category, product_type, budget, color, material, kitchen_size, installation_type, city, urgency, preferences)
- "summary": one-sentence semantic summary (may be empty)
- "recent": last few conversation turns
- "recommendations": products already shown this session
- "lead_stage" and "funnel_stage"
- "intent" + "sales_intent"
- "has_contact" flag

Choose EXACTLY ONE action: "ask", "recommend", "capture_lead", "show_dealer", "none".

Rules:
1. NEVER ask about a slot that already has a non-null value in "memory".
2. Ask AT MOST one short question (max 20 words, end with "?").
3. Pick the highest-leverage missing slot for the detected intent.
4. If all critical slots are filled and "has_contact" is true, prefer "recommend" or "show_dealer".
5. Never ask for phone, email, or address — capture flow handles those.
6. "reason" must match the slot you targeted (missing_budget, missing_color, missing_material, missing_kitchen_size, missing_installation_type, missing_city, missing_urgency, qualification, dealer_conversion, quotation_handoff, none).

Output strict JSON:
{
  "action": "ask" | "recommend" | "capture_lead" | "show_dealer" | "none",
  "question": string | null,
  "reason": string,
  "target_slot": string | null
}`;

type RawPlanner = {
  action?: string;
  question?: string | null;
  reason?: string;
  target_slot?: string | null;
};

function isEnabled(): boolean {
  return process.env.ENABLE_AI_FOLLOWUP === "true" || process.env.ENABLE_AI_FOLLOWUP === "1";
}

function knownSlots(state: ConversationState | null): Set<ConversationStateSlot> {
  const known = new Set<ConversationStateSlot>();
  if (!state) return known;
  const lookup: Record<ConversationStateSlot, unknown> = {
    category: state.category,
    product_type: state.productType,
    budget: state.budget,
    color: state.color,
    material: state.material,
    kitchen_size: state.kitchenSize,
    installation_type: state.installationType,
    city: state.city,
    urgency: state.urgency,
  };
  for (const slot of CONVERSATION_SLOTS) {
    const value = lookup[slot];
    if (value !== null && value !== undefined && String(value).trim().length > 0) {
      known.add(slot);
    }
  }
  return known;
}

function suggestTargetSlot(state: ConversationState | null): ConversationStateSlot | null {
  const known = knownSlots(state);
  for (const slot of PLANNER_SLOT_PRIORITY) {
    if (!known.has(slot)) return slot;
  }
  return null;
}

function reasonForSlot(slot: ConversationStateSlot | null): RecommendationFollowupReason {
  if (!slot) return "none";
  const map: Partial<Record<ConversationStateSlot, RecommendationFollowupReason>> = {
    budget: "missing_budget",
    color: "missing_color",
    material: "missing_material",
    kitchen_size: "missing_kitchen_size",
    installation_type: "missing_installation_type",
    city: "missing_city",
    urgency: "missing_urgency",
    category: "qualification",
    product_type: "qualification",
  };
  return map[slot] ?? "qualification";
}

function sanitizeQuestion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  if (trimmed.length > 240) return null;
  if (/\b(phone|email|whatsapp|mobile|contact\s+number|your\s+number)\b/i.test(trimmed)) return null;
  if (!/[?？]\s*$/.test(trimmed)) return null;
  return trimmed;
}

function questionContainsKnownSlotAnswer(
  question: string,
  state: ConversationState | null
): boolean {
  if (!state) return false;
  // Heuristic: don't echo a slot whose answer already lives in memory.
  // We only check noun phrases the planner most commonly leaks.
  const lowered = question.toLowerCase();
  const checks: Array<{ value: string | null; keyword: RegExp }> = [
    { value: state.budget, keyword: /\b(budget|price\s+range)\b/ },
    { value: state.color, keyword: /\b(colou?r|finish)\b/ },
    { value: state.material, keyword: /\b(material)\b/ },
    { value: state.kitchenSize, keyword: /\b(kitchen\s+size|how\s+big.*kitchen)\b/ },
    { value: state.installationType, keyword: /\b(installation\s+type|topmount|undermount|deck\s+mount|wall\s+mount)\b/ },
    { value: state.city, keyword: /\b(city|where.*located)\b/ },
  ];
  return checks.some((check) => check.value && check.keyword.test(lowered));
}

const VALID_ACTIONS: ReadonlySet<FollowupPlannerAction> = new Set([
  "ask",
  "recommend",
  "capture_lead",
  "show_dealer",
  "none",
]);

const VALID_REASONS: ReadonlySet<RecommendationFollowupReason> = new Set([
  "missing_budget",
  "missing_color",
  "missing_material",
  "missing_kitchen_size",
  "missing_installation_type",
  "missing_city",
  "missing_urgency",
  "qualification",
  "dealer_conversion",
  "quotation_handoff",
  "none",
]);

function coerceSlot(raw: unknown): ConversationStateSlot | null {
  if (typeof raw !== "string") return null;
  return (CONVERSATION_SLOTS as readonly string[]).includes(raw)
    ? (raw as ConversationStateSlot)
    : null;
}

function coerceAction(raw: unknown): FollowupPlannerAction {
  return typeof raw === "string" && VALID_ACTIONS.has(raw as FollowupPlannerAction)
    ? (raw as FollowupPlannerAction)
    : "none";
}

function coerceReason(raw: unknown): RecommendationFollowupReason {
  return typeof raw === "string" && VALID_REASONS.has(raw as RecommendationFollowupReason)
    ? (raw as RecommendationFollowupReason)
    : "none";
}

/**
 * Decide the next follow-up move. Always returns a value; check `aiUsed` to
 * know whether the LLM actually contributed. When `aiUsed === false` callers
 * should treat this as a hint only and prefer the rules-based engine output.
 */
export async function generateNextQuestion(
  input: FollowupPlannerInput
): Promise<FollowupPlannerOutput> {
  if (!isEnabled()) {
    return {
      action: "none",
      question: null,
      reason: "none",
      targetSlot: null,
      aiUsed: false,
    };
  }

  const known = knownSlots(input.state);
  const fallbackSlot = suggestTargetSlot(input.state);
  const userContent = JSON.stringify({
    memory: input.state
      ? {
          category: input.state.category,
          product_type: input.state.productType,
          budget: input.state.budget,
          color: input.state.color,
          material: input.state.material,
          kitchen_size: input.state.kitchenSize,
          installation_type: input.state.installationType,
          city: input.state.city,
          urgency: input.state.urgency,
          preferences: input.state.preferences,
        }
      : null,
    summary: input.summary,
    recent: input.recentMessages
      .slice(-8)
      .map((entry) => ({ role: entry.role, content: entry.content })),
    recommendations: input.recommendationsShown.map((rec) => ({ id: rec.id, name: rec.name })),
    lead_stage: input.leadStage,
    funnel_stage: input.funnelStage,
    intent: {
      categories: input.intent.categories,
      dealer_intent: input.intent.dealer_intent,
    },
    sales_intent: {
      intent: input.salesIntent.intent,
      urgency: input.salesIntent.urgency,
      budget: input.salesIntent.budget_type,
    },
    has_contact: input.hasContact,
  });

  const cacheKey = hashKey(`planner|${input.sessionId}|${userContent}`);
  const { data, aiUsed } = await callAIJsonCached<RawPlanner>(
    FOLLOWUP_SYSTEM,
    userContent,
    {},
    cacheKey
  );

  if (!aiUsed) {
    return {
      action: "none",
      question: null,
      reason: "none",
      targetSlot: fallbackSlot,
      aiUsed: false,
    };
  }

  const action = coerceAction(data?.action);
  const question = sanitizeQuestion(data?.question);
  const targetSlot = coerceSlot(data?.target_slot) ?? fallbackSlot;
  let reason = coerceReason(data?.reason);

  if (action === "ask" && question) {
    // Drop the question if it targets a slot we already know.
    if (targetSlot && known.has(targetSlot)) {
      return {
        action: "none",
        question: null,
        reason: reasonForSlot(suggestTargetSlot(input.state)),
        targetSlot: suggestTargetSlot(input.state),
        aiUsed: true,
      };
    }
    if (questionContainsKnownSlotAnswer(question, input.state)) {
      return {
        action: "none",
        question: null,
        reason: reasonForSlot(suggestTargetSlot(input.state)),
        targetSlot: suggestTargetSlot(input.state),
        aiUsed: true,
      };
    }
    if (reason === "none") reason = reasonForSlot(targetSlot);
  }

  return { action, question, reason, targetSlot, aiUsed: true };
}
