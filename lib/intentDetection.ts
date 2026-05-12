import type { IntentResult } from "@/lib/concierge";
import { sanitizeInferredCityValue } from "@/lib/inferredCitySanitize";
import type { BudgetType, DetectedSalesIntent, SalesIntentName, UrgencyType } from "@/types/lead";

type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

const CITY_PATTERN =
  /\b(?:in|near|from|city(?:\s+is)?|at)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})\b/;

function normalizeCategory(intent?: IntentResult): string | null {
  const category = intent?.categories?.[0];
  return category ? category.toLowerCase() : null;
}

function clampProbability(value: number): number {
  return Math.max(0, Math.min(0.98, Number(value.toFixed(2))));
}

function detectBudgetType(text: string): BudgetType {
  const lower = text.toLowerCase();
  if (/\b(premium|luxury|high[-\s]?end|best|top)\b/.test(lower)) return "high";
  if (/\b(under|below|budget|affordable|cheap|low[-\s]?cost)\b/.test(lower)) return "budget";
  if (/\b(mid|medium|moderate)\b/.test(lower)) return "mid";
  return "unknown";
}

function detectUrgency(text: string): UrgencyType {
  const lower = text.toLowerCase();
  if (/\b(urgent|today|asap|immediately|call\s+me|contact\s+me)\b/.test(lower)) return "high";
  if (/\b(soon|this\s+week|quotation|quote|dealer|installation)\b/.test(lower)) return "medium";
  return "low";
}

function detectCity(text: string, history: ConversationMessage[]): string | null {
  /** Assistant copy ("dealer in Mumbai…") falsely matched as user city when included here. */
  const recentUser = history.filter((m) => m.role === "user").slice(-4).map((m) => m.content);
  const combined = [text, ...recentUser].join("\n");
  const match = combined.match(CITY_PATTERN);
  if (!match?.[1]) return null;
  return sanitizeInferredCityValue(match[1].trim());
}

function chooseIntent(signals: string[]): SalesIntentName {
  if (signals.includes("contact_request")) return "contact_request";
  if (signals.includes("quotation_request")) return "quotation_request";
  if (signals.includes("dealer_inquiry")) return "dealer_inquiry";
  if (signals.includes("installation_inquiry")) return "installation_inquiry";
  if (signals.includes("premium_purchase")) return "premium_purchase";
  if (signals.includes("budget_purchase")) return "budget_purchase";
  return "browsing";
}

export function detectSalesIntent(
  message: string,
  existingIntent?: IntentResult,
  history: ConversationMessage[] = []
): DetectedSalesIntent {
  const lower = message.toLowerCase();
  const signals: string[] = [];
  let probability = 0.15;

  if (existingIntent?.categories?.length) {
    signals.push("product_interest");
    probability += 0.12;
  }
  if (/\b(quote|quotation|estimate|invoice)\b/.test(lower)) {
    signals.push("quotation_request");
    probability += 0.42;
  }
  if (/\b(contact\s+me|call\s+me|someone\s+contact|talk\s+to|sales\s+team)\b/.test(lower)) {
    signals.push("contact_request");
    probability += 0.48;
  }
  if (existingIntent?.dealer_intent || /\b(where\s+can\s+i\s+buy|dealer|store|showroom|near\s+me)\b/.test(lower)) {
    signals.push("dealer_inquiry");
    probability += 0.34;
  }
  if (/\b(install|installation|fitting|support|service)\b/.test(lower)) {
    signals.push("installation_inquiry");
    probability += 0.3;
  }
  if (/\b(premium|luxury|modular\s+kitchen|new\s+kitchen|setup|renovation)\b/.test(lower)) {
    signals.push("premium_purchase");
    probability += 0.28;
  }
  if (/\b(price|cost|budget|under|below|less\s+than|range)\b/.test(lower)) {
    signals.push("budget_purchase");
    probability += 0.2;
  }
  // Avoid treating generic "number" (e.g. "number of burners") as contact_shared — that inflated lead_probability.
  const looksLikeContactShare =
    /\b(phone|whatsapp|mobile|email)\b/.test(lower) ||
    /\b(?:your|my|the)\s+number\b/.test(lower) ||
    /\bnumber\s+is\b/.test(lower) ||
    /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(message) ||
    /\b\d{10}\b/.test(message);
  if (looksLikeContactShare) {
    signals.push("contact_shared");
    probability += 0.4;
  }

  return {
    intent: chooseIntent(signals),
    category: normalizeCategory(existingIntent),
    budget_type: detectBudgetType(message),
    city: detectCity(message, history),
    urgency: detectUrgency(message),
    lead_probability: clampProbability(probability),
    signals: Array.from(new Set(signals)),
  };
}
