import type { IntentResult, ProductCategory } from "@/lib/concierge";
import type { ConversationMessage } from "@/lib/followupEngine";
import { normalizeLoc, knownDealerStates } from "./dealer";

export const NOT_A_DEALER_CITY_REPLY =
  /\b(explore\s+(?:the\s+)?full\s+range|full\s+range(?:\s+of)?|show\s+(?:me\s+)?(?:the\s+)?full\s+range)\b/i;

export function toTitleCaseLocation(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function inferProductContextFromText(
  text: string
): { category: ProductCategory; keywords?: string[] } | null {
  const lower = text.toLowerCase();
  if (/\b(faucet|faucets|tap|taps)\b/.test(lower)) return { category: "Faucet" };
  if (/\b(sink|sinks)\b/.test(lower)) return { category: "Sink" };
  if (/\b(disposer|disposers|food\s*waste|waste\s+disposers?|water\s+disposers?|garbage\s*disposal)\b/.test(lower))
    return { category: "Disposer" };
  if (/\b(accessory|accessories|waste\s*coupling)\b/.test(lower)) return { category: "Accessory" };
  if (/\b(combo|combos)\b/.test(lower)) return { category: "Combo" };
  if (/\b(hob|hobs|burner|burners)\b/.test(lower)) return { category: "Appliance", keywords: ["hob"] };
  if (/\b(chimney|chimneys)\b/.test(lower)) return { category: "Appliance", keywords: ["chimney"] };
  if (/\b(dishwasher|dishwashers)\b/.test(lower)) return { category: "Appliance", keywords: ["dishwasher"] };
  if (/\b(appliance|appliances)\b/.test(lower)) return { category: "Appliance" };
  if (/\b(full|modular|complete|entire|new)\s+kitchen\b|\bkitchen\s+(makeover|package|setup|project)\b/i.test(lower))
    return { category: "Combo", keywords: ["kitchen"] };
  return null;
}

export function inferRecentProductContext(
  history: ConversationMessage[]
): { category: ProductCategory; keywords?: string[] } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "user") continue;
    const context = inferProductContextFromText(history[i].content);
    if (context) return context;
  }
  for (let i = history.length - 1; i >= 0; i--) {
    const context = inferProductContextFromText(history[i].content);
    if (context) return context;
  }
  return null;
}

export function hasRecentExplicitDealerLocationAsk(history: ConversationMessage[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "assistant") continue;
    const c = history[i].content;
    return (
      /\b(which\s+city|what\s+city|city\s+or\s+state|your\s+city|your\s+state|pincode|postal\s+code)\b/i.test(c) ||
      /\b(where\s+are\s+you|where\s+do\s+you\s+live|location\s+in)\b/i.test(c) ||
      /\bfind\s+(a\s+)?(carysil\s+)?dealer\b/i.test(c) ||
      /\bwhere\s+to\s+buy\b/i.test(c) ||
      /\bI'll\s+find\s+carysil\s+dealers\b/i.test(c)
    );
  }
  return false;
}

export function isOpenEndedFollowup(message: string): boolean {
  return /^(any|anything|any\s+one|any\s+of\s+them|any\s+(?:size|type|style|budget|finish|colour|color)|no\s+(?:size|type|style|budget|finish|colour|color)\s+preference|no\s+preference|no\s+preferences|does(?:n'?t)?\s+matter|show\s+me|show\s+options|show\s+some|yes|yeah|yep|ok|okay|whatever|whatever\s+is\s+best|you\s+choose|recommend|recommend\s+some|best\s+one|explore\s+(?:the\s+)?full\s+range)(?:\s+(sink|sinks|faucet|faucets|tap|taps|hob|hobs|chimney|chimneys|dishwasher|dishwashers|disposer|disposers|combo|combos|accessory|accessories|appliance|appliances))?[\.\!]*$/i.test(
    message.trim()
  );
}

export function inferFollowupProductFilters(
  message: string,
  context: { category: ProductCategory; keywords?: string[] }
): Partial<IntentResult["filters"]> | null {
  const lower = message.toLowerCase();
  const keywords: string[] = [];

  if (context.category === "Faucet") {
    if (/\bpull[- ]?out\b|\bspray\b/.test(lower)) keywords.push("pull-out");
    if (/\bstandard\s+spout\b|\bstandard\b|\bnormal\b|\bregular\b|\bspout\b|\bswivel\b/.test(lower)) keywords.push("spout");
    if (/\bwall[- ]?mount\b|\bwall\b/.test(lower)) keywords.push("wall");
    if (/\bdeck[- ]?mount\b|\bdeck\b/.test(lower)) keywords.push("deck");
    if (/\bchrome\b/.test(lower)) keywords.push("chrome");
    if (/\bblack\b|\bmatt\s+black\b|\bmatte\s+black\b/.test(lower)) keywords.push("black");
    if (/\bpvd\b|\brose\s+gold\b|\bgold\b|\bgun\s+metal\b/.test(lower)) {
      keywords.push(lower.match(/\brose\s+gold\b/) ? "rose gold" : lower.match(/\bgun\s+metal\b/) ? "gun metal" : "pvd");
    }
    if (/\b(budget|price|under|below|affordable|cheap|premium|luxury|medium|high)\b/.test(lower)) keywords.push("budget");
  }

  if (context.category === "Sink") {
    if (/\bsingle\b/.test(lower)) keywords.push("single bowl");
    if (/\bdouble\b/.test(lower)) keywords.push("double bowl");
    if (/\bdrainboard\b/.test(lower)) keywords.push("drainboard");
    if (/\bblack\b/.test(lower)) keywords.push("black");
    if (/\bquartz\b/.test(lower)) keywords.push("quartz");
    if (/\bstainless\s*steel\b|\bss\b/.test(lower)) keywords.push("stainless steel");
    if (/\b(white|grey|gray|champagne|beige)\b/.test(lower)) keywords.push(lower.match(/\bchampagne\b/i) ? "champagne" : "finish");
    if (/\b(budget|price|under|below|affordable|cheap|premium|luxury|medium|kitchen|bathroom)\b/.test(lower)) keywords.push("context");
    if (/\b\d{2}\s*x\s*\d{2}\b|\b(45|50|55|60|70|75|80|85|90|100)\s*cm\b/i.test(lower)) keywords.push("size");
  }

  if (context.category === "Appliance") {
    if (/\bhobs?\b|\bburners?\b/.test(lower)) keywords.push("hob");
    if (/\bchimneys?\b/.test(lower)) keywords.push("chimney");
    if (/\bdishwashers?\b/.test(lower)) keywords.push("dishwasher");
    if (/\b(cooking\s*range|freestanding|standing\s*range|built[- ]?in)\b/.test(lower)) keywords.push("cooking range");
    if (/\b(gas|induction)\b/.test(lower)) keywords.push(lower.match(/\binduction\b/) ? "induction" : "gas");
    if (/\b(60|75|90)\s*cm\b/i.test(lower)) keywords.push("size");
    if (/\b([345])\s*burner\b|three|four|five\s*burner/i.test(lower)) keywords.push("burners");

    const hobContinuation =
      Boolean(context.keywords?.some((k) => /\b(hob|burner)\b/i.test(k))) ||
      /\b(built[- ]?in\s+hob|hob\s+size)\b/i.test(lower);
    if (hobContinuation) {
      const showSizeRefinement =
        /\b(show\s+(me\s+)?(the\s+)?)?(larger|bigger|big(\s+one)?|widest|the\s+biggest|max(?:imum)?|full[-\s]?width)\b/i.test(lower) ||
        /\b(show\s+(me\s+)?(the\s+)?)?(smaller|more\s+compact|compact(\s+(one|option|size))?|slim(line)?|the\s+smallest)\b/i.test(lower) ||
        /\b(medium|mid[-\s]?size|in\s+between)\b/i.test(lower) ||
        /^(ok|okay|yes|yeah|yep|sure)\s*,?\s*(show\s+)?(the\s+)?(larger|bigger|smaller|compact)\b/i.test(lower.trim());
      if (showSizeRefinement) {
        keywords.push("size");
        if (
          /\b(larger|bigger|big(\s+one)?|widest|the\s+biggest|max(?:imum)?|full[-\s]?width|90\s*cm)\b/i.test(lower) ||
          /^(ok|okay|yes|yeah|yep|sure)\s*,?\s*(show\s+)?(the\s+)?(larger|bigger)\b/i.test(lower.trim())
        ) {
          return { keywords: Array.from(new Set([...(context.keywords || []), ...keywords, "hob"])), size: "90 cm" };
        }
        if (
          /\b(smaller|more\s+compact|compact(\s+(one|option|size))?|slim(line)?|the\s+smallest|60\s*cm)\b/i.test(lower) ||
          /^(ok|okay|yes|yeah|yep|sure)\s*,?\s*(show\s+)?(the\s+)?compact\b/i.test(lower.trim())
        ) {
          return { keywords: Array.from(new Set([...(context.keywords || []), ...keywords, "hob"])), size: "60 cm" };
        }
        if (/\b(medium|mid[-\s]?size|in\s+between|75\s*cm)\b/i.test(lower)) {
          return { keywords: Array.from(new Set([...(context.keywords || []), ...keywords, "hob"])), size: "75 cm" };
        }
      }
    }
  }

  if (context.category === "Disposer") {
    const m = lower.match(/\b(\d+)\s*(people|persons|members)\b/);
    if (m) keywords.push(`${m[1]}-person household`);
    const fm = lower.match(/\bfamily\s+of\s*(\d+)\b/);
    if (fm) keywords.push(`${fm[1]}-person household`);
    if (/\b(quiet|silent|low\s*noise|noise)\b/.test(lower)) keywords.push("quiet");
    if (/\b(power|hp|horsepower)\b/.test(lower)) keywords.push("power");
    if (/\binstallation\b|\binstall\b|\bguidance\b/.test(lower)) keywords.push("installation");
  }

  return keywords.length > 0 ? { keywords: Array.from(new Set([...(context.keywords || []), ...keywords])) } : null;
}

export function looksLikeNaturalLanguageShoppingRequest(message: string): boolean {
  const t = message.trim().toLowerCase();
  if (/\b[6-9]\d{9}\b/.test(t)) return true;
  if (/\b(i|we)\s+(need|want|would\s+like|am\s+looking|are\s+looking|just\s+need|just\s+want)\b/.test(t)) return true;
  if (/\b(looking\s+for|help\s+(with|me)|show\s+me|can\s+you|could\s+you)\b/.test(t)) return true;
  if (/\b(full|new|complete|entire|modular|whole)\s+(kitchen|bathroom|bath)\b/.test(t)) return true;
  if (/\b(kitchen|bathroom)\s+(package|project|reno|renovation|setup|design|for\s+my)\b/.test(t)) return true;
  return false;
}

export function isLikelyLocationReply(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length < 2 || trimmed.length > 60) return false;
  if (NOT_A_DEALER_CITY_REPLY.test(trimmed)) return false;
  if (looksLikeNaturalLanguageShoppingRequest(trimmed)) return false;
  if (inferProductContextFromText(trimmed)) return false;
  if (/^\d{5,6}$/.test(trimmed)) return true;
  if (/[?]/.test(trimmed)) return false;
  if (
    /\b(sinks?|faucets?|taps?|hobs?|chimneys?|dishwashers?|disposers?|combos?|accessories?|appliances?|burners?|dealers?|stores?|showrooms?)\b/i.test(trimmed)
  ) {
    return false;
  }
  if (/\bkitchen\b|\bbathroom\b|\bhome\b|\bhouse\b|\breno\b|\brenovation\b/i.test(trimmed)) return false;
  return /^[a-zA-Z][a-zA-Z\s.-]*$/.test(trimmed);
}

export function resolveFollowupIntent(
  message: string,
  history: ConversationMessage[]
): IntentResult | null {
  if (history.length === 0) return null;

  if (hasRecentExplicitDealerLocationAsk(history) && isLikelyLocationReply(message)) {
    if (inferProductContextFromText(message)) return null;
    const normalizedMessage = normalizeLoc(message);
    const isPincodeOnly = /^\d{5,6}$/.test(message.trim());
    const location = knownDealerStates.has(normalizedMessage)
      ? { state: toTitleCaseLocation(message) }
      : { city: toTitleCaseLocation(message) };

    return {
      categories: [],
      asking_clarification: isPincodeOnly,
      clarification_message: isPincodeOnly
        ? "I don't have pincode-level dealer data yet. Which city or state are you in?"
        : null,
      dealer_intent: true,
      location: isPincodeOnly ? undefined : location,
      filters: {},
    };
  }

  const context = inferProductContextFromText(message) || inferRecentProductContext(history);
  if (!context) return null;

  const followupFilters = inferFollowupProductFilters(message, context);

  const disposerAnswer =
    context.category === "Disposer" &&
    /\b(\d+\s*(people|persons|members)|people\s+in|house\s*hold|household|family|noise|quiet|silent|power|hp|horsepower|installation|install|guidance|no\s+preference|any(\s+one)?\s+is\s+fine|doesn'?t\s+matter|not\s+sure|surprise\s+me|water\s+disposers?|(just|only)\b[\s\w]{0,24}\bdisposers?\b)\b/i.test(
      message
    );
  if (disposerAnswer) {
    return {
      categories: ["Disposer"],
      asking_clarification: false,
      clarification_message: null,
      filters: followupFilters || {},
    };
  }

  if (!isOpenEndedFollowup(message) && !followupFilters) return null;

  return {
    categories: [context.category],
    asking_clarification: false,
    clarification_message: null,
    filters: followupFilters || (context.keywords ? { keywords: context.keywords } : {}),
  };
}
