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
- Map synonyms: "tap" → Faucet, "sink"/"quartz sink"/"kitchen sink" → Sink, "disposer"/"food waste" → Disposer, "accessories"/"waste coupling" → Accessory, "hob"/"chimney"/"dishwasher" → Appliance.
- If the user is vague ("help me", "what do you have"), set asking_clarification to true and suggest they pick a category or ask for a dealer.
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
    if (parsed.asking_clarification && parsed.clarification_message) {
      return parsed;
    }
    if (parsed.dealer_intent) {
      return parsed;
    }
    if (parsed.categories.length === 0) {
      parsed.asking_clarification = true;
      parsed.clarification_message =
        parsed.clarification_message ||
        "What type of product are you looking for? (e.g. kitchen sink, faucet, food waste disposer)";
    }
    return parsed;
  } catch {
    return {
      categories: [],
      asking_clarification: true,
      clarification_message:
        "What type of product are you looking for? (e.g. kitchen sink, faucet, food waste disposer)",
      filters: {},
    };
  }
}
