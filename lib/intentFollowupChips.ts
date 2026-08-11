import type { IntentResult } from "@/lib/concierge";
import { describeCategoryRange } from "@/lib/catalogueRange";

/** User gave enough shopping intent (e.g. cheapest / budget) — don't block catalogue on mount/finish chips. */
const BUDGET_OR_VALUE_INTENT =
  /\b(cheap|cheapest|affordable|budget|low[\s-]?cost|economy|value|entry[\s-]?level|basic|inexpensive|lowest\s+price|best\s+price|show\s+me|just\s+show|give\s+me\s+options)\b/i;

export function hasProductRefinement(message: string, intent: IntentResult): boolean {
  const lower = message.toLowerCase();
  const filters = intent.filters;
  const hasStructuredFilter = Boolean(
    filters?.material ||
      filters?.price_range ||
      filters?.style ||
      filters?.size ||
      (Array.isArray(filters?.keywords) && filters.keywords.length > 0)
  );
  if (hasStructuredFilter) return true;

  if (intent.categories.includes("Faucet")) {
    if (BUDGET_OR_VALUE_INTENT.test(lower)) return true;
    return /\b(chrome|black|pvd|rose\s*gold|gold|matt|matte|pull[- ]?out|spray|standard\s+spout|standard|normal|regular|spout|swivel|deck[- ]?mount|wall[- ]?mount|budget|price|under|tap|taps|kitchen|bathroom)\b/i.test(
      lower
    );
  }

  if (intent.categories.includes("Sink")) {
    if (BUDGET_OR_VALUE_INTENT.test(lower)) return true;
    return /\b(single|double|bowl|drainboard|quartz|stainless\s*steel|black|white|grey|gray|champagne|budget|price|under|kitchen|bathroom|\d{2}x\d{2}|\d{2,3}\s*cm)\b/i.test(
      lower
    );
  }

  if (intent.categories.includes("Appliance")) {
    if (
      /\b(hob|hobs|chimney|chimneys|dishwasher|dishwashers|burner|burners|cooking\s*range|freestanding|built[- ]?in|gas|induction|\b(60|75|90)\s*cm\b|\b[345]\s*burner|three|four|five)\b/i.test(
        lower
      )
    ) {
      return true;
    }
    if (/\b(show|see|list|want|need|looking\s+for|recommend)\b/i.test(lower) && /\b(hob|hobs|chimney|dishwasher|appliance)\b/i.test(lower)) {
      return true;
    }
    return /\b(appliances?|kitchen\s+appliance)\b/i.test(lower);
  }

  if (intent.categories.includes("Combo")) {
    return /\b(combo|sink|faucet|size|finish|budget|range|under|premium|quartz|chrome)\b/i.test(lower);
  }

  if (intent.categories.includes("Accessory")) {
    return /\b(accessories?|coupling|mount|waste|basket|strainer|grid)\b/i.test(lower);
  }

  if (intent.categories.includes("Disposer")) {
    if (
      /\b(\d+\s*(people|persons|members)|people\s+in|house\s*hold|household|family\s+of\s*\d+|noise|quiet|silent|power|horsepower|\b\d[\d.]*\s*hp\b|\b(half|one|1|3\/4)\s*hp\b|installation|install|under\s*sink|batch\s*feed|continuous)\b/i.test(
        lower
      )
    ) {
      return true;
    }
    if (/\b(water\s+disposers?|waste\s+disposers?|food\s*waste|garbage\s*disposal)\b/i.test(lower)) return true;
    if (/\b(show|see|list|want|need|looking\s+for|recommend)\b/i.test(lower) && /\b(disposers?)\b/i.test(lower)) return true;
    return /\bfamily\b/i.test(lower);
  }

  return false;
}

type ChatTurn = { role: string; content: string };

/**
 * We already ran one pre-catalogue clarification for this category — if the user repeats or
 * insists (e.g. "cheapest faucets" again), show products instead of looping on the same questions.
 */
export function recentlyAssistantAskedPreCataloguePrefs(history: ChatTurn[], intent: IntentResult): boolean {
  const assistantTail = history.slice(-6).filter((m) => m.role === "assistant");
  const blob = assistantTail.map((m) => m.content).join("\n");
  if (intent.categories.includes("Faucet")) {
    if (/\b(deck|wall)[\s-]*mount|pull[\s-]?out|standard\s+spout|\bPVD\b|chrome\s*\/\s*black|preferred\s+finish/i.test(blob))
      return true;
  }
  if (intent.categories.includes("Sink")) {
    if (/\bsingle[\s-]?bowl|double[\s-]?bowl|quartz|stainless|material|size\s+and\s+budget/i.test(blob))
      return true;
  }
  if (intent.categories.includes("Disposer")) {
    if (/\bhousehold|people\s+in|noise|power|installation/i.test(blob)) return true;
  }
  if (intent.categories.includes("Combo")) {
    if (/\bsink\s*\+\s*faucet|combo|preferred\s+size|full\s+range/i.test(blob)) return true;
  }
  return false;
}

/** One clarification turn is enough; afterwards show the catalogue unless intent already has refinement. */
export function shouldAskBeforeProductRecommendations(
  message: string,
  intent: IntentResult,
  resolvedFromHistory: boolean,
  history: ChatTurn[]
): boolean {
  if (resolvedFromHistory || intent.asking_clarification || intent.dealer_intent) return false;
  if (recentlyAssistantAskedPreCataloguePrefs(history, intent)) return false;
  return buildRecommendationFollowups(message, intent).length > 0;
}

export function buildRecommendationFollowups(message: string, intent: IntentResult): string[] {
  if (intent.dealer_intent || intent.categories.length !== 1 || hasProductRefinement(message, intent)) {
    return [];
  }

  if (intent.categories.includes("Faucet")) {
    return [
      "Do you prefer deck-mount or wall-mount?",
      "Any preferred finish (chrome / black / PVD)?",
      "Do you want a pull-out spray or a standard spout?",
    ];
  }

  if (intent.categories.includes("Sink")) {
    return [
      "Are you looking for a single-bowl or double-bowl sink?",
      "Any preferred material (quartz / stainless steel) or finish?",
      "Any size and budget range?",
    ];
  }

  if (intent.categories.includes("Disposer")) {
    return [
      "How many people are in the household?",
      "Do you have any noise or power preference?",
      "Do you want installation guidance too?",
    ];
  }

  if (intent.categories.includes("Combo")) {
    return [
      "Do you want a sink + faucet combo, or something else?",
      "Any preferred size or finish?",
      "Explore the full range.",
    ];
  }

  return [];
}

/**
 * Suggestion chips when intent detection asked for clarification (weak/ambiguous query).
 */
export async function buildIntentClarificationFollowups(
  intent: IntentResult,
  userRawMessage: string
): Promise<string[]> {
  const lower = userRawMessage.toLowerCase();
  const followups: string[] = [];
  const keywords: string[] =
    intent.filters?.keywords == null
      ? []
      : Array.isArray(intent.filters.keywords)
        ? (intent.filters.keywords as unknown[]).map((k) => String(k).toLowerCase())
        : [String(intent.filters.keywords).toLowerCase()];
  const wantsHob = keywords.includes("hob") || /\b(hob|burner|burners)\b/i.test(lower);
  const wantsChimney = keywords.includes("chimney") || /\bchimney\b|\bchimneys\b/i.test(lower);
  const wantsDishwasher = keywords.includes("dishwasher") || /\bdishwasher\b|\bdishwashers\b/i.test(lower);

  if (intent.dealer_intent) {
    followups.push(
      "Which city or state are you in?",
      "You can also say India to see dealers across the country."
    );
  } else if (!intent.dealer_intent && intent.categories.includes("Sink")) {
    followups.push(
      "Are you looking for a single-bowl or double-bowl sink?",
      "Any preferred material (quartz / stainless steel) or finish?",
      "Any size and budget range?"
    );
  } else if (!intent.dealer_intent && intent.categories.includes("Faucet")) {
    followups.push(
      "Do you prefer deck-mount or wall-mount?",
      "Any preferred finish (chrome / black / PVD)?",
      "Do you want a pull-out spray or a standard spout?"
    );
  } else if (!intent.dealer_intent && intent.categories.includes("Disposer")) {
    followups.push(
      "How many people are in the household?",
      "Do you have any noise or power preference?",
      "Do you want installation guidance too?"
    );
  } else if (!intent.dealer_intent && intent.categories.includes("Accessory")) {
    followups.push(
      "Which accessory are you looking for (e.g. waste coupling, sink accessories)?",
      "Is it for a particular sink model/size?",
      "Do you want to explore the full range?"
    );
  } else if (!intent.dealer_intent && intent.categories.includes("Appliance") && wantsHob) {
    followups.push(
      "Are you looking for a specific size?",
      "Do you need an induction or gas hob?",
      "How many burners do you want (3 / 4 / 5)?",
      "Explore the full range."
    );
  } else if (!intent.dealer_intent && intent.categories.includes("Appliance") && wantsChimney) {
    followups.push(
      "Which size do you need (60 cm / 90 cm)?",
      "Wall-mounted or island chimney?",
      "Do you want ducted or ductless (filter) type?",
      "Explore the full range."
    );
  } else if (!intent.dealer_intent && intent.categories.includes("Appliance") && wantsDishwasher) {
    followups.push(
      "Built-in or free-standing?",
      "How many place settings do you need (e.g. 12/14)?",
      "Any size constraint in your cabinet space?",
      "Explore the full range."
    );
  } else if (!intent.dealer_intent && intent.categories.includes("Appliance")) {
    // Named from live stock rather than the old hardcoded "hob, chimney, or
    // dishwasher" — that listed 3 of the 14 appliance sub-types we actually carry.
    const applianceRange = await describeCategoryRange("Appliance", 6);
    followups.push(
      applianceRange
        ? `Are you looking for ${applianceRange.toLowerCase()}?`
        : "Are you looking for a hob (burners), chimney, or dishwasher?",
      "Do you have any size preference (e.g. 60 cm / 90 cm)?",
      "Explore the full range."
    );
  } else if (!intent.dealer_intent && intent.categories.includes("Combo")) {
    followups.push(
      "Do you want a sink + faucet combo, or something else?",
      "Any preferred size or finish?",
      "Explore the full range."
    );
  } else {
    followups.push(
      // "combo" intentionally dropped — there are no active combo products, so
      // offering it just leads to a dead end.
      "Are you looking for a sink, faucet, disposer, hob, appliance, or accessories?",
      "Any preferred size, finish, or budget?",
      "If you tell me what you’re installing it for (kitchen/bathroom), I can narrow it down."
    );
  }

  return followups;
}

export function getProductClarificationMessage(intent: IntentResult): string {
  if (intent.categories.includes("Faucet")) {
    return "Sure, I can help with faucets. To narrow it down, what type are you looking for?";
  }
  if (intent.categories.includes("Sink")) {
    return "Sure, I can help with sinks. To narrow it down, what type are you looking for?";
  }
  if (intent.categories.includes("Disposer")) {
    return "Sure, I can help with food waste disposers. To narrow it down, what setup do you have?";
  }
  if (intent.categories.includes("Combo")) {
    return "Sure, I can help with combos. To narrow it down, what combination are you looking for?";
  }
  return "Sure, I can help. To narrow it down, what type are you looking for?";
}
