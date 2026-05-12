import { callAIJson } from "@/lib/ai";
import type { IntentResult } from "@/lib/concierge";

const CLARIFICATION_PLANNER_SYSTEM = `You are the dialogue planner for AskCary, Carysil's premium kitchen and bath shopping assistant (carysil.com).

You do NOT recommend specific product SKUs. You decide how to speak to the shopper and which quick-reply chips to show next.

You will receive JSON from the app including:
- mode: "pre_catalogue" (we need a bit more product detail before search) or "intent_clarification" (the user's query was ambiguous)
- the latest user message and recent conversation
- structured intent (categories, dealer vs product, filters)
- sales_intent summary
- backend_opening_hint: a safe template line from rules (you may rephrase warmly but keep the same intent)
- backend_suggested_chips: topic anchors from rules — reuse their substance; you may shorten or rephrase for flow (do not invent unrelated categories)

Rules:
1. Write assistant_message as 1–3 short sentences: acknowledge what they said, stay on topic, sound human and premium — not a form.
2. End with at most ONE clear question, OR invite them to use the chips — do not stack many questions in one message.
3. NEVER ask for phone number, email, or address in this turn (lead capture is handled separately by the app).
4. If user_volunteered_phone is true: thank them briefly for sharing their number — NEVER say you cannot store it, refuse it, or cite privacy as a reason to ignore it. The backend records contact details; keep guiding them on product preferences in the same warm tone.
5. Do NOT use the word "dealer" or "dealers" in assistant_message or suggestion_chips unless dealer_intent is true in the provided intent (it confuses location routing). Prefer "product range", "sinks", "faucets", etc.
6. suggestion_chips: 3–6 items, each under 72 characters, actionable, specific to Carysil categories (sinks, faucets, disposers, appliances, accessories, combos). Omit dealer/city chips unless dealer_intent is true.
7. If dealer_intent is true, chips should help locate them (city, state, India-wide) — not product specs.
8. Respond with JSON only, keys: assistant_message (string), suggestion_chips (array of strings).

If unsure, stay close to backend_opening_hint and backend_suggested_chips.`;

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
  };

  const { data, aiUsed } = await callAIJson<PlanJson>(
    CLARIFICATION_PLANNER_SYSTEM,
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
