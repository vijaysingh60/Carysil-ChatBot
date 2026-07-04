import { callAIJson } from "@/lib/ai";
import { getPrompt } from "@/lib/prompts";
import type { IntentResult } from "@/lib/concierge";

export type ClarificationPlannerInput = {
  mode: "pre_catalogue" | "intent_clarification";
  userMessage: string;
  historyLines: string;
  intent: Pick<IntentResult, "categories" | "asking_clarification" | "dealer_intent" | "filters"> & {
    clarification_hint?: string | null;
  };
  salesIntent: { intent: string; category?: string; budget_type?: string };
  backendOpeningHint: string;
  backendSuggestedChips: string[];
  /** True when message contains a plausible Indian mobile; model must not refuse to accept it. */
  userVolunteeredPhone?: boolean;
  /** Known first name from conversation memory, if any. */
  userName?: string | null;
  /** True once the name has already been acknowledged this session — must not repeat it. */
  nameAcknowledged?: boolean;
  /** This-turn sentiment signal from the conversation analyzer, for tone matching only. */
  sentiment?: "positive" | "neutral" | "negative" | null;
};

type PlanJson = {
  assistant_message: string;
  suggestion_chips: string[];
};

function sanitizeChips(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) return fallback;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const t = item.trim().replace(/\s+/g, " ");
    if (!t || t.length > 72) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= 6) break;
  }
  return out.length > 0 ? out : fallback;
}

function sanitizeMessage(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const t = raw.trim().replace(/\s+/g, " ");
  if (!t) return fallback;
  return t.length > 900 ? `${t.slice(0, 897)}...` : t;
}

/** Product clarification must not surface dealer/location chips — they trip "city reply" heuristics in the API. */
function stripDealerChipsUnlessIntent(
  chips: string[],
  dealerIntent: boolean,
  chipFallback: string[]
): string[] {
  if (dealerIntent) return chips;
  const locationOrDealer = /\b(dealer|dealers|showroom|showrooms|which\s+city|your\s+city|near\s+me|pincode)\b/i;
  const filtered = chips.filter((c) => !locationOrDealer.test(c));
  const fbFiltered = chipFallback.filter((c) => !locationOrDealer.test(c));
  if (filtered.length > 0) return filtered;
  if (fbFiltered.length > 0) return fbFiltered;
  return chipFallback;
}

/**
 * Use GPT with full structured context to phrase the clarification turn and chips.
 * Falls back to rule-based hint + chips when API is unavailable or JSON is invalid.
 */
export async function planClarificationWithGPT(
  input: ClarificationPlannerInput
): Promise<{ message: string; followups: string[]; gptUsed: boolean }> {
  const chipFallback = input.backendSuggestedChips.filter(Boolean).slice(0, 8);
  const openingFallback = input.backendOpeningHint.trim() || "What would you like help with?";

  const fallback: PlanJson = {
    assistant_message: openingFallback,
    suggestion_chips: chipFallback,
  };

  const payload = {
    mode: input.mode,
    user_message: input.userMessage,
    recent_conversation: input.historyLines || "(no prior turns)",
    user_volunteered_phone: Boolean(input.userVolunteeredPhone),
    intent: {
      categories: input.intent.categories,
      dealer_intent: Boolean(input.intent.dealer_intent),
      asking_clarification: input.intent.asking_clarification,
      filters: input.intent.filters ?? {},
      clarification_hint: input.intent.clarification_hint ?? null,
    },
    sales_intent: input.salesIntent,
    backend_opening_hint: input.backendOpeningHint,
    backend_suggested_chips: input.backendSuggestedChips,
    user_name: input.userName ?? null,
    name_acknowledged: Boolean(input.nameAcknowledged),
    sentiment: input.sentiment ?? "neutral",
  };

  const { data, aiUsed } = await callAIJson<PlanJson>(
    getPrompt("clarification_planner"),
    `Plan the next assistant turn from this context:\n${JSON.stringify(payload, null, 2)}`,
    fallback
  );

  const message = sanitizeMessage(data.assistant_message, openingFallback);
  const rawFollowups = sanitizeChips(data.suggestion_chips, chipFallback);
  const followups = stripDealerChipsUnlessIntent(
    rawFollowups,
    Boolean(input.intent.dealer_intent),
    chipFallback
  );

  return {
    message,
    followups,
    gptUsed: aiUsed,
  };
}

export type SmallTalkPlannerInput = {
  userMessage: string;
  historyLines: string;
  greeting: boolean;
  farewell: boolean;
  gratitude: boolean;
  smallTalk: boolean;
  userName?: string | null;
  nameAcknowledged?: boolean;
  sentiment?: "positive" | "neutral" | "negative" | null;
};

type SmallTalkJson = {
  message: string;
  suggestion_chips: string[];
};

const SMALL_TALK_CHIPS_FALLBACK = [
  "I'm looking for a kitchen sink.",
  "I need a faucet or tap.",
  "Show me food waste disposers.",
  "I'm interested in hobs or chimneys.",
  "Find a dealer near me.",
];

/**
 * Lightweight reply for pure small talk (greeting/farewell/gratitude/chit-chat
 * with no product or dealer intent). Skips catalogue retrieval entirely —
 * this is the cheap fast path, not the full recommendation pipeline.
 */
export async function planSmallTalkResponse(
  input: SmallTalkPlannerInput
): Promise<{ message: string; followups: string[]; gptUsed: boolean }> {
  const nameAcknowledged = Boolean(input.nameAcknowledged);
  const openingFallback = input.userName && !nameAcknowledged
    ? `Nice to meet you, ${input.userName}! What can I help you find today?`
    : input.farewell
      ? "Take care! Come back anytime you need help with Carysil products."
      : "Hi! What can I help you find today — sinks, faucets, disposers, or appliances?";

  const fallback: SmallTalkJson = {
    message: openingFallback,
    suggestion_chips: input.farewell ? [] : SMALL_TALK_CHIPS_FALLBACK,
  };

  const payload = {
    user_message: input.userMessage,
    recent_conversation: input.historyLines || "(no prior turns)",
    greeting: input.greeting,
    farewell: input.farewell,
    gratitude: input.gratitude,
    small_talk: input.smallTalk,
    user_name: input.userName ?? null,
    name_acknowledged: nameAcknowledged,
    sentiment: input.sentiment ?? "neutral",
  };

  const { data, aiUsed } = await callAIJson<SmallTalkJson>(
    getPrompt("small_talk_response"),
    `Reply to this small-talk turn:\n${JSON.stringify(payload, null, 2)}`,
    fallback
  );

  const message = sanitizeMessage(data.message, openingFallback);
  const followups = input.farewell ? [] : sanitizeChips(data.suggestion_chips, SMALL_TALK_CHIPS_FALLBACK);

  return { message, followups, gptUsed: aiUsed };
}
