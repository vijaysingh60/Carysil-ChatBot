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
    size?: string;
    keywords?: string[];
  };
  /** True when user is asking for dealers, stores, outlets, or where to buy. */
  dealer_intent?: boolean;
  /** When dealer_intent is true: city and/or state if mentioned. */
  location?: { city?: string; state?: string };
};

function extractSizeFilter(message: string): string | undefined {
  const m = message.match(/\b(45|50|55|60|70|75|80|85|90|100|110|120)\s*cm\b/i);
  if (m) return `${m[1]} cm`;
  const m2 = message.match(/\b(\d{2,3})\s*cm\b/i);
  if (m2) return `${m2[1]} cm`;
  return undefined;
}

function extractApplianceKeywords(message: string): string[] {
  const lower = message.toLowerCase();
  const keys: string[] = [];
  // "burner(s)" in this project refers to a hob
  if (/\b(hob|burner|burners)\b/.test(lower)) keys.push("hob");
  if (/\b(dishwasher|dishwashers)\b/.test(lower)) keys.push("dishwasher");
  if (/\b(chimney|chimneys)\b/.test(lower)) keys.push("chimney");
  if (/\b(cooking\s*range|standing\s*(?:cooking\s*)?range|freestanding\s*(?:cooking\s*)?range)\b/.test(lower))
    keys.push("cooking range");
  return Array.from(new Set(keys));
}

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
- IMPORTANT: If the user mentions ANY product type we carry (e.g. "kitchen faucet", "faucet", "sink", "disposer"), set that category in "categories" and set asking_clarification to FALSE. Only ask for clarification when the message has NO product type we carry, or when they ask for something we don't have (e.g. "bath tub", "bathtub", "toilet", "shower enclosure", "bidet")—in that case leave categories [] and set a friendly clarification_message that we don't have that product and list what we do have (sinks, faucets, disposers, combos, appliances, accessories).
- We do NOT carry: bath tubs, bathtubs, toilets/WC, bidets, shower enclosures/cubicles, jacuzzis, bathroom cabinets/vanity units, water heaters/geysers. For these, ask for clarification with a message like "We don't have [X] at the moment. Here's what we do have: ..."
- Examples: "I need a kitchen faucet. What do you have?" → categories: ["Faucet"], asking_clarification: false. "Recommend quartz sinks for modern kitchen" → categories: ["Sink"], asking_clarification: false. "Which dealer in Hyderabad?" → dealer_intent: true, location: { city: "Hyderabad" }.
- If they mention multiple product types, include both in categories.
- Infer "filters" when clear: material, price_range, style.
- Also infer "filters.size" when the user mentions a size like "60 cm", "75cm", "90 cm".
- For appliances: if the user mentions "hob/burner", "chimney", or "dishwasher", add a helpful "filters.keywords" hint with that subtype.

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

const WHAT_WE_HAVE =
  "Here’s what we do have: kitchen & bathroom sinks, faucets, food waste disposers, combos, appliances (hob, chimney, dishwasher), and accessories. What would you like to explore?";

/** Keywords for products we DO carry – single source of truth. Use for intent override and messaging. */
export const PRODUCT_KEYWORDS_WE_HAVE =
  /\b(sink|sinks|faucet|faucets|tap|taps|disposer|disposers|food\s*waste|combo|combos|hob|hobs|chimney|chimneys|dishwasher|dishwashers|appliance|appliances|accessory|accessories|waste\s*coupling)\b/i;

/** True if the message mentions at least one product type we carry. */
export function isProductWeCarry(message: string): boolean {
  return PRODUCT_KEYWORDS_WE_HAVE.test(message.trim());
}

/** Product types we don't carry: regex pattern → friendly name for the reply. */
const OUT_OF_CATALOGUE: { pattern: RegExp; name: string }[] = [
  { pattern: /\b(bath\s*tub|bathtub|bath tubs|bathtubs)\b/i, name: "bath tubs" },
  { pattern: /\b(shower\s*cubicle|shower\s*cabin|walk[- ]?in\s*shower|shower\s*enclosure)\b/i, name: "shower enclosures" },
  { pattern: /\b(toilet|wc|water\s*closet|commode)\b/i, name: "toilets" },
  { pattern: /\bbidet\b/i, name: "bidets" },
  { pattern: /\b(jacuzzi|hot\s*tub|whirlpool)\b/i, name: "jacuzzis / hot tubs" },
  { pattern: /\b(bathroom\s*cabinet|vanity\s*unit)\b/i, name: "bathroom cabinets / vanity units" },
  { pattern: /\b(water\s*heater|geyser)\b/i, name: "water heaters / geysers" },
];

/** If the user is asking for a product we don't carry, return a friendly "we don't have X" message. */
function getOutOfCatalogueReply(message: string): string | null {
  const lower = message.toLowerCase().trim();
  for (const { pattern, name } of OUT_OF_CATALOGUE) {
    if (pattern.test(lower)) {
      return `We don’t have ${name} at the moment. ${WHAT_WE_HAVE}`;
    }
  }
  return null;
}

/** Infer product categories from message keywords when AI returns none (e.g. "kitchen faucet" → Faucet). */
function inferCategoriesFromMessage(message: string): ProductCategory[] {
  const lower = message.toLowerCase();
  const inferred: ProductCategory[] = [];
  if (/\b(faucet|faucets|tap|taps|kitchen faucet|bathroom faucet)\b/.test(lower)) inferred.push("Faucet");
  if (/\b(sink|sinks|quartz sink|kitchen sink|bathroom sink)\b/.test(lower)) inferred.push("Sink");
  if (/\b(disposer|disposers|food waste|garbage disposal)\b/.test(lower)) inferred.push("Disposer");
  if (/\b(accessory|accessories|waste coupling)\b/.test(lower)) inferred.push("Accessory");
  if (/\b(hob|chimney|dishwasher|appliance|appliances)\b/.test(lower)) inferred.push("Appliance");
  if (/\b(combo|combos)\b/.test(lower)) inferred.push("Combo");
  return Array.from(new Set(inferred));
}

/** Words that indicate the user has given specifics (size, style, budget, finish, etc.) – if present, we go straight to recommendations. */
const REFINEMENT_TERMS =
  /(\bsingle\b|\bdouble\b|\bbowl\b|\bdrainboard\b|\bbudget\b|\bprice\b|\brange\b|\bchrome\b|\bblack\b|\bmodern\b|\bquartz\b|\bstainless\s*steel\b|\bpull[- ]?out\b|\bsize\b|\b(45|50|55|60|70|75|80|85|90|100|110|120)\s*cm\b|\bgas\b|\binduction\b|\b4\s*burner\b|\b5\s*burner\b|\bfamily\s*of\s*\d|\bmedium\b|\blarge\b|\bsmall\b|\bwhite\b|\brose\s*gold\b|\bmatt\b|\bmatte\b|\bbrushed\b|\bdeck\s*mount\b|\bwall\s*mount\b|\bpvd\b|\bfinish\b|\bcolour\b|\bcolor\b)/i;

/** "Explore full range" / "full range of X" → treat as specified, go straight to results. */
const FULL_RANGE_PATTERN = /\b(explore\s+full\s+range|full\s+range\s+of|show\s+(?:me\s+)?(?:the\s+)?full\s+range)\b/i;

/** True if the query is under-specified: one category, short message, no refinement terms → show clarification + selectables. */
function isVagueCategoryQuery(message: string, categories: ProductCategory[]): boolean {
  if (categories.length !== 1) return false;
  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();
  if (FULL_RANGE_PATTERN.test(lower)) return false;
  if (REFINEMENT_TERMS.test(lower)) return false;
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  const bareOnly = /^(sink|sinks|faucet|faucets|tap|taps|disposer|disposers|accessory|accessories|appliance|appliances|hob|hobs|combo|combos|chimney|chimneys|dishwasher|dishwashers)\s*[\.\?]?\s*$/i.test(lower);
  if (bareOnly) return true;
  // If user hasn't provided any refinements, treat short messages as vague and ask questions first.
  return wordCount <= 10;
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
    const lower = userMessage.toLowerCase();
    // "I'm in Bangalore." / "I'm from Mumbai" → dealer intent with location so we return dealers, not same suggestions
    const cityReplyMatch = userMessage.match(/\b(?:I'm in|I am in|I'm from|I am from)\s+([^.?!]+)/i);
    if (cityReplyMatch) {
      const rawCity = cityReplyMatch[1].trim();
      if (rawCity.length > 0) {
        const cityDisplay = rawCity.replace(/\b\w/g, (c) => c.toUpperCase());
        parsed.dealer_intent = true;
        parsed.location = { city: cityDisplay };
        parsed.asking_clarification = false;
        parsed.clarification_message = null;
        parsed.categories = [];
        return parsed;
      }
    }
    const dealerKeywords = /\b(dealer|dealers|find\s+a\s+dealer|where\s+to\s+buy|store|outlet|showroom|nearest\s+dealer)\b/i.test(lower);
    if (dealerKeywords && !parsed.dealer_intent) {
      parsed.dealer_intent = true;
      parsed.categories = [];
      parsed.asking_clarification = true;
      parsed.clarification_message =
        "Which city or state are you in? I'll find Carysil dealers near you.";
      return parsed;
    }
    if (parsed.dealer_intent) {
      return parsed;
    }

    // Normalize/derive size filter from user message (works even if the model doesn't set it)
    const size = extractSizeFilter(userMessage);
    if (size) {
      parsed.filters = parsed.filters || {};
      parsed.filters.size = parsed.filters.size || size;
    }

    // Appliance subtype hint (hob/burner vs chimney vs dishwasher vs cooking range)
    if (parsed.categories.includes("Appliance")) {
      const kws = extractApplianceKeywords(userMessage);
      if (kws.length > 0) {
        parsed.filters = parsed.filters || {};
        parsed.filters.keywords = Array.isArray(parsed.filters.keywords)
          ? Array.from(new Set([...(parsed.filters.keywords as string[]), ...kws]))
          : kws;
      }
    }

    const needsHobClarification =
      /\bhob\b/.test(lower) &&
      !/(60|75|90)\s*cm|\b4\s*burner|\bfour\s*burner|\b5\s*burner|\bfive\s*burner|\binduction\b|\bgas\b/.test(
        lower
      );
    if (parsed.categories.length === 0) {
      const inferred = inferCategoriesFromMessage(userMessage);
      if (inferred.length > 0) {
        parsed.categories = inferred;
      }
      const outOfCatalogue = getOutOfCatalogueReply(userMessage);
      const isVague = inferred.length > 0 ? isVagueCategoryQuery(userMessage, parsed.categories) : true;
      if (outOfCatalogue) {
        parsed.asking_clarification = true;
        parsed.clarification_message = outOfCatalogue;
      } else if (!isVague && parsed.categories.length >= 1) {
        parsed.asking_clarification = false;
        parsed.clarification_message = null;
      } else if (isVague && parsed.categories.length === 1) {
        parsed.asking_clarification = true;
        if (parsed.categories.includes("Sink")) {
          parsed.clarification_message =
            "Great, you’re looking for a sink. Could you tell me your size preference (single or double bowl, with or without drainboard), colour/finish, and an approximate budget?";
        } else if (parsed.categories.includes("Faucet")) {
          parsed.clarification_message =
            "Great, you’re looking for a faucet. Do you prefer a particular finish (chrome, black, PVD), mounting type (deck or wall), and any budget range?";
        } else if (parsed.categories.includes("Disposer")) {
          parsed.clarification_message =
            "Great, you’re looking for a food waste disposer. How many people are in the household, and do you have any brand/feature preferences?";
        } else if (parsed.categories.includes("Appliance")) {
          parsed.clarification_message = lower.includes("hob")
            ? "To recommend the right hob, could you tell me the size (60 cm / 75 cm / 90 cm) and whether you prefer gas or induction, or explore the full range?"
            : "We have hobs, chimneys, and dishwashers. Which are you looking for? You can pick one or explore the full range.";
        } else if (parsed.categories.includes("Accessory")) {
          parsed.clarification_message =
            "What kind of accessory? For example: waste couplings, mounting accessories, or explore the full range.";
        } else if (parsed.categories.includes("Combo")) {
          parsed.clarification_message =
            "We have sink and faucet combos. Any preferred size, finish, or explore the full range?";
        } else {
          parsed.clarification_message =
            "What type of product are you looking for? (e.g. kitchen sink, faucet, food waste disposer)";
        }
      } else {
        parsed.asking_clarification = true;
        parsed.clarification_message =
          parsed.clarification_message ||
          "What type of product are you looking for? (e.g. kitchen sink, faucet, food waste disposer)";
      }
    } else {
      const isVague = isVagueCategoryQuery(userMessage, parsed.categories);
      if (needsHobClarification && parsed.categories.includes("Appliance")) {
        parsed.asking_clarification = true;
        parsed.clarification_message =
          parsed.clarification_message ||
          "To recommend the right hob, could you tell me the size (60 cm / 75 cm / 90 cm) and whether you prefer gas or induction, or explore the full range?";
      } else if (isVague) {
        parsed.asking_clarification = true;
        if (parsed.categories.includes("Sink")) {
          parsed.clarification_message =
            parsed.clarification_message ||
            "Great, you’re looking for a sink. Could you tell me your size preference (single or double bowl, with or without drainboard), colour/finish, and an approximate budget?";
        } else if (parsed.categories.includes("Faucet")) {
          parsed.clarification_message =
            parsed.clarification_message ||
            "Great, you’re looking for a faucet. Do you prefer a particular finish (chrome, black, PVD), mounting type (deck or wall), and any budget range?";
        } else if (parsed.categories.includes("Disposer")) {
          parsed.clarification_message =
            parsed.clarification_message ||
            "Great, you’re looking for a food waste disposer. How many people are in the household, and do you have any brand/feature preferences?";
        } else if (parsed.categories.includes("Appliance")) {
          parsed.clarification_message =
            parsed.clarification_message ||
            (lower.includes("hob")
              ? "To recommend the right hob, could you tell me the size (60 cm / 75 cm / 90 cm) and whether you prefer gas or induction, or explore the full range?"
              : "We have hobs, chimneys, and dishwashers. Which are you looking for? You can pick one or explore the full range.");
        } else if (parsed.categories.includes("Accessory")) {
          parsed.clarification_message =
            parsed.clarification_message ||
            "What kind of accessory? For example: waste couplings, mounting accessories, or explore the full range.";
        } else if (parsed.categories.includes("Combo")) {
          parsed.clarification_message =
            parsed.clarification_message ||
            "We have sink and faucet combos. Any preferred size, finish, or explore the full range?";
        } else {
          parsed.asking_clarification = false;
          parsed.clarification_message = null;
        }
      } else {
        parsed.asking_clarification = false;
        parsed.clarification_message = null;
      }
    }
    // Never say "we don't have X" when the user asked for a product we carry (e.g. chimney, hob, dishwasher)
    if (
      parsed.clarification_message &&
      /don't have|we don't have|do not have/i.test(parsed.clarification_message) &&
      isProductWeCarry(userMessage)
    ) {
      parsed.asking_clarification = false;
      parsed.clarification_message = null;
    }
    return parsed;
  } catch {
    const inferred = inferCategoriesFromMessage(userMessage);
    const lower = userMessage.toLowerCase();
    const needsHobClarification =
      /\bhob\b/.test(lower) &&
      !/(60|75|90)\s*cm|\b4\s*burner|\bfour\s*burner|\b5\s*burner|\bfive\s*burner|\binduction\b|\bgas\b/.test(
        lower
      );
    const isVague = inferred.length === 1 && isVagueCategoryQuery(userMessage, inferred);
    if (inferred.length > 0) {
      if (needsHobClarification && inferred.includes("Appliance")) {
        return {
          categories: inferred,
          asking_clarification: true,
          clarification_message:
            "To recommend the right hob, could you tell me the size (60 cm / 75 cm / 90 cm) and whether you prefer gas or induction, or explore the full range?",
          filters: {},
        };
      } else if (isVague) {
        if (inferred.includes("Sink")) {
          return {
            categories: inferred,
            asking_clarification: true,
            clarification_message:
              "Great, you’re looking for a sink. Could you tell me your size preference (single or double bowl, with or without drainboard), colour/finish, and an approximate budget?",
            filters: {},
          };
        }
        if (inferred.includes("Faucet")) {
          return {
            categories: inferred,
            asking_clarification: true,
            clarification_message:
              "Great, you’re looking for a faucet. Do you prefer a particular finish (chrome, black, PVD), mounting type (deck or wall), and any budget range?",
            filters: {},
          };
        }
        if (inferred.includes("Disposer")) {
          return {
            categories: inferred,
            asking_clarification: true,
            clarification_message:
              "Great, you’re looking for a food waste disposer. How many people are in the household, and do you have any brand/feature preferences?",
            filters: {},
          };
        }
        if (inferred.includes("Appliance")) {
          return {
            categories: inferred,
            asking_clarification: true,
            clarification_message: lower.includes("hob")
              ? "To recommend the right hob, could you tell me the size (60 cm / 75 cm / 90 cm) and whether you prefer gas or induction, or explore the full range?"
              : "We have hobs, chimneys, and dishwashers. Which are you looking for? You can pick one or explore the full range.",
            filters: {},
          };
        }
        if (inferred.includes("Accessory")) {
          return {
            categories: inferred,
            asking_clarification: true,
            clarification_message:
              "What kind of accessory? For example: waste couplings, mounting accessories, or explore the full range.",
            filters: {},
          };
        }
        if (inferred.includes("Combo")) {
          return {
            categories: inferred,
            asking_clarification: true,
            clarification_message:
              "We have sink and faucet combos. Any preferred size, finish, or explore the full range?",
            filters: {},
          };
        }
      }
      return {
        categories: inferred,
        asking_clarification: false,
        clarification_message: null,
        filters: {},
      };
    }
    const outOfCatalogue = getOutOfCatalogueReply(userMessage);
    return {
      categories: [],
      asking_clarification: true,
      clarification_message:
        outOfCatalogue ||
        "What type of product are you looking for? (e.g. kitchen sink, faucet, food waste disposer)",
      filters: {},
    };
  }
}
