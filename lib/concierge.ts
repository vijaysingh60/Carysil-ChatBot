import { callAI } from "@/lib/ai";

/** Catalogue categories in products.json */
export const CATEGORIES = [
  "Sink",
  "Faucet",
  "Combo",
  "Appliance",
  "Disposer",
  "Accessory",
] as const;

export type ProductCategory = (typeof CATEGORIES)[number];

export type IntentResult = {
  categories: ProductCategory[];
  asking_clarification: boolean;
  clarification_message: string | null;
  filters?: {
    material?: string;
    price_range?: string;
    style?: string;
    keywords?: string[];
  };
  /** True when user is asking for dealers, stores, outlets, or where to buy. */
  dealer_intent?: boolean;
  /** When dealer_intent is true: city and/or state if mentioned. */
  location?: { city?: string; state?: string };
};

const INTENT_SYSTEM = `You are an intent classifier for Carysil (carysil.com), a kitchen and bathroom brand.

Your job: read the user's message and decide (A) if they want a DEALER/STORE, or (B) which product CATEGORY they want. Reply with JSON only (no markdown).

**DEALER intent:**
- Set "dealer_intent" to true when the user asks for: dealer, store, outlet, showroom, where to buy, nearest dealer, contact a dealer, buy in [place], dealer in [city], etc.
- If they mention a location (city or state), extract it into "location": { "city": "Hyderabad", "state": "Telangana" }. Use standard Indian city/state names (e.g. Bangalore not Bengaluru for consistency, Mumbai, Delhi NCR → Gurgaon/Noida, etc.).
- If dealer_intent is true but NO city/state is mentioned, set "asking_clarification" to true and "clarification_message" to a short question like "Which city or state are you in? I'll find Carysil dealers near you."
- When dealer_intent is true, leave "categories" as [].

**PRODUCT intent (when not dealer):**
- Allowed categories (use exactly these): Sink, Faucet, Combo, Appliance, Disposer, Accessory.
- Map synonyms and common phrases to ONE category (use exactly these spellings):
  - Faucet: "faucet", "faucets", "tap", "taps", "kitchen faucet", "bathroom faucet", "I need a faucet", "what do you have in faucets", "show me faucets".
  - Sink: "sink", "sinks", "quartz sink", "kitchen sink", "bathroom sink", "I need a sink".
  - Disposer: "disposer", "disposers", "food waste", "food waste disposer", "garbage disposal".
  - Accessory: "accessories", "waste coupling", "accessory".
  - Appliance: "hob", "chimney", "dishwasher", "appliance", "appliances".
  - Combo: "combo", "sink and faucet combo".
- IMPORTANT: If the user mentions ANY product type (e.g. "kitchen faucet", "faucet", "sink", "disposer"), set that category in "categories" and set asking_clarification to FALSE. Only ask for clarification when the message has NO product type at all (e.g. "help me", "what do you have" with no product word, "hi").
- Examples: "I need a kitchen faucet. What do you have?" → categories: ["Faucet"], asking_clarification: false. "Recommend quartz sinks for modern kitchen" → categories: ["Sink"], asking_clarification: false. "Which dealer in Hyderabad?" → dealer_intent: true, location: { city: "Hyderabad" }.
- If they mention multiple product types, include both in categories.
- Infer "filters" when clear: material, price_range, style.

**Response format – strict JSON only:**
{
  "dealer_intent": true or false,
  "location": { "city": "Hyderabad", "state": "Telangana" } or omit if not dealer or no place mentioned,
  "categories": ["Sink"] or [] etc. Empty [] when dealer_intent is true.
  "asking_clarification": true or false,
  "clarification_message": "Your short question" or null,
  "filters": { "material": "...", "price_range": "...", "style": "..." } or omit
}`;

const INTENT_PLACEHOLDER: string = JSON.stringify(
  {
    categories: [],
    asking_clarification: true,
    clarification_message:
      "I'd be happy to help! What are you looking for? For example: kitchen sink, faucet, food waste disposer, accessories, or appliances (hob, chimney, dishwasher).",
    filters: {},
  },
  null,
  2
);

/** Infer product categories from message keywords when AI returns none (e.g. "kitchen faucet" → Faucet). */
function inferCategoriesFromMessage(message: string): ProductCategory[] {
  const lower = message.toLowerCase();
  const inferred: ProductCategory[] = [];
  if (/\b(faucet|faucets|tap|taps|kitchen faucet|bathroom faucet)\b/.test(lower)) inferred.push("Faucet");
  if (/\b(sink|sinks|quartz sink|kitchen sink|bathroom sink)\b/.test(lower)) inferred.push("Sink");
  if (/\b(disposer|disposers|food waste|garbage disposal)\b/.test(lower)) inferred.push("Disposer");
  if (/\b(accessory|accessories|waste coupling)\b/.test(lower)) inferred.push("Accessory");
  if (/\b(hob|chimney|dishwasher|appliance|appliances)\b/.test(lower)) inferred.push("Appliance");
  if (/\bcombo\b/.test(lower)) inferred.push("Combo");
  return Array.from(new Set(inferred));
}

export async function detectIntent(userMessage: string): Promise<IntentResult> {
  const { text } = await callAI(
    INTENT_SYSTEM,
    `User message:\n${userMessage}\n\nRespond with JSON only.`,
    INTENT_PLACEHOLDER
  );

  const raw = text.replace(/```json?\s*|\s*```/g, "").trim();
  try {
    const parsed = JSON.parse(raw) as IntentResult;
    if (!Array.isArray(parsed.categories)) parsed.categories = [];
    parsed.categories = parsed.categories.filter((c) =>
      CATEGORIES.includes(c as ProductCategory)
    ) as ProductCategory[];
    if (parsed.dealer_intent) {
      return parsed;
    }
    if (parsed.categories.length === 0) {
      const inferred = inferCategoriesFromMessage(userMessage);
      if (inferred.length > 0) {
        parsed.categories = inferred;
        parsed.asking_clarification = false;
        parsed.clarification_message = null;
        return parsed;
      }
      parsed.asking_clarification = true;
      parsed.clarification_message =
        parsed.clarification_message ||
        "What type of product are you looking for? (e.g. kitchen sink, faucet, food waste disposer)";
    } else {
      parsed.asking_clarification = false;
      parsed.clarification_message = null;
    }
    if (parsed.asking_clarification && parsed.clarification_message) {
      return parsed;
    }
    return parsed;
  } catch {
    const inferred = inferCategoriesFromMessage(userMessage);
    if (inferred.length > 0) {
      return {
        categories: inferred,
        asking_clarification: false,
        clarification_message: null,
        filters: {},
      };
    }
    return {
      categories: [],
      asking_clarification: true,
      clarification_message:
        "What type of product are you looking for? (e.g. kitchen sink, faucet, food waste disposer)",
      filters: {},
    };
  }
}
