import type { IntentResult, ProductCategory } from "@/lib/concierge";
import { extractContactInfo, updateLead, calculateLeadScore, getLeadContactSnapshot } from "@/services/leadService";
import { recomputeFunnelStage, markConverted } from "@/services/funnelService";
import type {
  ContactInfo,
  DetectedSalesIntent,
  FollowupCategory,
  FollowupStage,
  InterestedProduct,
  LeadUpdate,
} from "@/types/lead";

export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export type RecommendationLite = {
  id: string;
  name: string;
  category?: string;
  description?: string;
};

export type FollowupContext = {
  message: string;
  history: ConversationMessage[];
  intent: IntentResult;
  salesIntent: DetectedSalesIntent;
  recommendations: RecommendationLite[];
  contactInfo: ContactInfo;
  recommendationConfidence?: "low" | "medium" | "high";
  /**
   * True when the user has already declined to narrow down this turn (or exhausted the
   * pre-catalogue clarification attempt budget for this category — see the guard in
   * app/api/ai/concierge/route.ts). Once true, this engine must not ask another filter
   * question (bowl type, finish, hob type, etc.) — same "give up after 1 attempt" policy
   * as the pre-catalogue guard, applied here so the post-recommendation branches don't
   * re-open the same loop the pre-catalogue fix closed.
   */
  declinesRefinement?: boolean;
};

export type FollowupResult = {
  question: string | null;
  category: FollowupCategory;
  stage: FollowupStage;
  shouldOfferLead: boolean;
  shouldRequestContact: boolean;
  rationale: string;
};

const COLOR_KEYWORDS = /\b(black|matte|matt|matt\s+black|matte\s+black|white|grey|gray|gold|rose\s+gold|pvd|chrome|brushed)\b/i;
const PREMIUM_KEYWORDS = /\b(premium|luxury|high[- ]?end|top[- ]?tier|best|modular\s+kitchen|new\s+kitchen)\b/i;
const KITCHEN_SIZE_HINT = /\b(compact|small|medium|large|big|spacious)\s+kitchen\b/i;
const COMPACT_KITCHEN = /\b(compact|small)\s+kitchen\b/i;
const LARGE_KITCHEN = /\b(large|big|spacious)\s+kitchen\b/i;

export const STAGE_RANK: Record<FollowupStage, number> = {
  browsing: 0,
  preferences_collected: 1,
  recommendations_shown: 2,
  cross_sell_offered: 3,
  dealer_offered: 4,
  lead_requested: 5,
  lead_captured: 6,
};

function maxStage(a: FollowupStage, b: FollowupStage): FollowupStage {
  return STAGE_RANK[a] >= STAGE_RANK[b] ? a : b;
}

function inferStageFromHistory(history: ConversationMessage[]): FollowupStage {
  let stage: FollowupStage = "browsing";
  for (const message of history) {
    if (message.role !== "assistant") continue;
    const content = message.content;
    if (/\b(thank|thanks|noted|shared with the carysil team|details with the)\b/i.test(content)) {
      stage = maxStage(stage, "lead_captured");
    } else if (
      /\b(share your (city|phone|number)|may i have your|please share your|your city and phone)\b/i.test(content)
    ) {
      stage = maxStage(stage, "lead_requested");
    } else if (
      /\b(connect you with|dealer near your|carysil dealer near|nearest carysil dealer|carysil partner)\b/i.test(content)
    ) {
      stage = maxStage(stage, "dealer_offered");
    } else if (
      // Do NOT use bare "combo" — product names often contain "Combo" and falsely skip follow-ups.
      /\b(matching\s+faucet|matching\s+sink|matching\s+accessories|along\s+with|suggest\s+matching|cross[- ]?sell|sink\s+and\s+faucet\s+combo|recommend.*(faucet|accessor))\b/i.test(
        content
      )
    ) {
      stage = maxStage(stage, "cross_sell_offered");
    } else if (/\bView →|recommendations\s+shown|here are some|i recommend\b/i.test(content)) {
      stage = maxStage(stage, "recommendations_shown");
    }
  }
  return stage;
}

function recentlyAskedQuestion(history: ConversationMessage[], pattern: RegExp, lookback = 6): boolean {
  return history
    .slice(-lookback)
    .some((message) => message.role === "assistant" && pattern.test(message.content));
}

function userHasSizeOrBowlPreference(message: string, history: ConversationMessage[]): boolean {
  const combined = [message, ...history.slice(-4).map((m) => m.content)].join(" \n ");
  return /\b(single\s+bowl|double\s+bowl|drainboard|\d{2,3}\s*cm|small|medium|large)\b/i.test(combined);
}

function userHasFinishOrColor(message: string, history: ConversationMessage[]): boolean {
  const combined = [message, ...history.slice(-4).map((m) => m.content)].join(" \n ");
  return COLOR_KEYWORDS.test(combined);
}

function userMentionsHobType(message: string, history: ConversationMessage[]): boolean {
  const combined = [message, ...history.slice(-4).map((m) => m.content)].join(" \n ");
  return /\b(gas|induction|3\s*burner|4\s*burner|5\s*burner|three\s*burner|four\s*burner|five\s*burner)\b/i.test(combined);
}

function userHasCity(contactInfo: ContactInfo, salesIntent: DetectedSalesIntent): string | null {
  if (contactInfo.city) return contactInfo.city;
  if (salesIntent.city) return salesIntent.city;
  return null;
}

function isAffirmativeReply(message: string): boolean {
  return /^(yes|yeah|yep|sure|ok|okay|please|sounds\s+good|do\s+it|connect\s+me|please\s+do)[\s.!?]*$/i.test(message.trim());
}

function isExplicitDealerRequest(message: string): boolean {
  return /\b(dealer|store|outlet|showroom|where\s+can\s+i\s+buy|nearest|near\s+me)\b/i.test(message);
}

function isExplicitQuotationRequest(message: string): boolean {
  return /\b(quote|quotation|estimate|invoice|price\s+list|pricing)\b/i.test(message);
}

function isExplicitContactRequest(message: string): boolean {
  return /\b(contact\s+me|call\s+me|sales\s+team|someone\s+contact|talk\s+to\s+sales|reach\s+out)\b/i.test(message);
}

function isInstallationRequest(message: string): boolean {
  return /\b(install|installation|fitting|onsite|on-site|technician|setup)\b/i.test(message);
}

function detectColorMatch(message: string, history: ConversationMessage[]): string | null {
  const combined = [message, ...history.slice(-4).map((m) => m.content)].join(" \n ").toLowerCase();
  if (/\b(matt(e)?\s+black|matt(e)?-black)\b/.test(combined)) return "matte black";
  if (/\bblack\b/.test(combined)) return "black";
  if (/\brose\s+gold\b/.test(combined)) return "rose gold";
  if (/\bgun\s*metal\b/.test(combined)) return "gun metal";
  if (/\bgold\b/.test(combined)) return "gold";
  if (/\bchrome\b/.test(combined)) return "chrome";
  if (/\bpvd\b/.test(combined)) return "PVD";
  return null;
}

function inferKitchenSize(message: string, history: ConversationMessage[]): "compact" | "large" | null {
  const combined = [message, ...history.slice(-4).map((m) => m.content)].join(" \n ");
  if (COMPACT_KITCHEN.test(combined)) return "compact";
  if (LARGE_KITCHEN.test(combined)) return "large";
  if (KITCHEN_SIZE_HINT.test(combined)) return null;
  return null;
}

function isPremiumIntent(message: string, salesIntent: DetectedSalesIntent): boolean {
  if (salesIntent.budget_type === "high") return true;
  if (salesIntent.signals.includes("premium_purchase")) return true;
  return PREMIUM_KEYWORDS.test(message);
}

/**
 * Produce ONE contextual follow-up question after recommendations.
 * Priority order:
 *   1. Strong buying intent → ask for contact / dealer connect
 *   2. User shared city → offer nearest dealer
 *   3. Premium / specific colour → cross-sell matching products
 *   4. Sink/faucet/appliance still missing key preference → clarification
 *   5. Generic cross-sell / dealer suggestion fallback
 */
/** Last-resort question so we never end a recommendation turn without one follow-up. */
export function defaultFollowupAfterRecommendations(
  category: ProductCategory | null,
  recommendations: RecommendationLite[]
): string {
  const primary = recommendations[0];
  const cat = (category || primary?.category || "Sink") as string;
  const lower = cat.toLowerCase();
  if (lower.includes("sink")) {
    return "Would you prefer a single-bowl or double-bowl configuration for your kitchen?";
  }
  if (lower.includes("faucet") || lower.includes("tap")) {
    return "Would you like deck-mount or wall-mount, and any finish preference (chrome, matte black, PVD)?";
  }
  if (lower.includes("disposer")) {
    return "Would you like installation guidance for the disposer as well?";
  }
  if (lower.includes("hob") || lower.includes("chimney") || lower.includes("appliance")) {
    return "Would you like help choosing the right size (e.g. 60 cm / 90 cm) for your kitchen layout?";
  }
  return "Would you like me to connect you with a Carysil dealer near your city for pricing and availability?";
}

export function generateFollowupQuestion(ctx: FollowupContext): FollowupResult {
  const { message, history, intent, salesIntent, recommendations, contactInfo } = ctx;
  const hasRecommendations = recommendations.length > 0;
  const inferredStage = inferStageFromHistory(history);
  const fromIntent = intent.categories?.[0] as ProductCategory | undefined;
  const fromCatalog = recommendations[0]?.category as ProductCategory | undefined;
  const category: ProductCategory | null = (fromIntent ?? fromCatalog ?? null) as ProductCategory | null;
  const city = userHasCity(contactInfo, salesIntent);
  const lowConfidence = ctx.recommendationConfidence === "low";

  if (!hasRecommendations) {
    return {
      question: null,
      category: "none",
      stage: inferredStage,
      shouldOfferLead: false,
      shouldRequestContact: false,
      rationale: "no_recommendations",
    };
  }

  if (
    isExplicitContactRequest(message) ||
    isExplicitQuotationRequest(message) ||
    salesIntent.intent === "contact_request" ||
    salesIntent.intent === "quotation_request"
  ) {
    if (contactInfo.phone || contactInfo.email) {
      return {
        question: "Thanks — I have your details. Our Carysil team will reach out shortly with pricing and dealer support.",
        category: "lead",
        stage: "lead_captured",
        shouldOfferLead: false,
        shouldRequestContact: false,
        rationale: "contact_already_shared",
      };
    }
    return {
      question:
        "Sure — may I have your city and phone number so a Carysil partner can share pricing and help with the next steps?",
      category: "lead",
      stage: "lead_requested",
      shouldOfferLead: true,
      shouldRequestContact: true,
      rationale: "explicit_contact_or_quotation",
    };
  }

  if (
    isExplicitDealerRequest(message) ||
    salesIntent.intent === "dealer_inquiry" ||
    isAffirmativeReply(message) && inferredStage === "dealer_offered"
  ) {
    if (city) {
      return {
        question: `Great — to connect you with the nearest Carysil dealer in ${city}, may I have your phone number?`,
        category: "lead",
        stage: "lead_requested",
        shouldOfferLead: true,
        shouldRequestContact: true,
        rationale: "dealer_request_with_city",
      };
    }
    return {
      question: "Sure — which city are you in? I'll connect you with the nearest Carysil dealer.",
      category: "dealer",
      stage: "dealer_offered",
      shouldOfferLead: true,
      shouldRequestContact: false,
      rationale: "dealer_request_no_city",
    };
  }

  if (isInstallationRequest(message)) {
    return {
      question:
        "I can arrange installation support too — could you share your city and phone number so our partner can coordinate the visit?",
      category: "lead",
      stage: "lead_requested",
      shouldOfferLead: true,
      shouldRequestContact: true,
      rationale: "installation_request",
    };
  }

  if (lowConfidence && category && !ctx.declinesRefinement) {
    const clarifier = clarificationQuestion(category, message, history);
    if (clarifier) {
      return {
        question: clarifier,
        category: "clarification",
        stage: "preferences_collected",
        shouldOfferLead: false,
        shouldRequestContact: false,
        rationale: "low_confidence_clarify",
      };
    }
  }

  if (city && STAGE_RANK[inferredStage] < STAGE_RANK.dealer_offered) {
    return {
      question: `Would you like me to share Carysil dealers near ${city} so you can check availability and pricing?`,
      category: "dealer",
      stage: "dealer_offered",
      shouldOfferLead: true,
      shouldRequestContact: false,
      rationale: "user_has_city",
    };
  }

  if (
    category === "Sink" &&
    STAGE_RANK[inferredStage] < STAGE_RANK.cross_sell_offered &&
    !recentlyAskedQuestion(history, /\b(matching\s+faucet|matching\s+matte|matching\s+chrome|matching\s+pvd)\b/i)
  ) {
    const color = detectColorMatch(message, history);
    if (color) {
      return {
        question: `Would you like matching ${color} faucet suggestions to pair with the sink?`,
        category: "cross_sell",
        stage: "cross_sell_offered",
        shouldOfferLead: false,
        shouldRequestContact: false,
        rationale: "sink_cross_sell_color",
      };
    }
    if (isPremiumIntent(message, salesIntent)) {
      return {
        question: "Would you like premium faucet recommendations to go with these sinks?",
        category: "cross_sell",
        stage: "cross_sell_offered",
        shouldOfferLead: false,
        shouldRequestContact: false,
        rationale: "sink_cross_sell_premium",
      };
    }
    if (
      !ctx.declinesRefinement &&
      !userHasSizeOrBowlPreference(message, history) &&
      !recentlyAskedQuestion(history, /single\s+bowl|double\s+bowl/i)
    ) {
      return {
        question: "Would you prefer a single-bowl or double-bowl configuration?",
        category: "clarification",
        stage: "preferences_collected",
        shouldOfferLead: false,
        shouldRequestContact: false,
        rationale: "sink_preference_bowl",
      };
    }
  }

  if (
    category === "Faucet" &&
    STAGE_RANK[inferredStage] < STAGE_RANK.cross_sell_offered &&
    !recentlyAskedQuestion(history, /matching\s+sink|sink\s+to\s+pair/i)
  ) {
    if (!ctx.declinesRefinement && !userHasFinishOrColor(message, history)) {
      return {
        question: "Any preferred finish — chrome, matte black, or PVD?",
        category: "clarification",
        stage: "preferences_collected",
        shouldOfferLead: false,
        shouldRequestContact: false,
        rationale: "faucet_preference_finish",
      };
    }
    return {
      question: "Would you like matching Carysil sink recommendations to complete the setup?",
      category: "cross_sell",
      stage: "cross_sell_offered",
      shouldOfferLead: false,
      shouldRequestContact: false,
      rationale: "faucet_cross_sell_sink",
    };
  }

  if (category === "Disposer" && STAGE_RANK[inferredStage] < STAGE_RANK.cross_sell_offered) {
    if (!recentlyAskedQuestion(history, /installation|fitting/i)) {
      return {
        question: "Would you like installation guidance for the disposer as well?",
        category: "cross_sell",
        stage: "cross_sell_offered",
        shouldOfferLead: false,
        shouldRequestContact: false,
        rationale: "disposer_install",
      };
    }
  }

  if (category === "Appliance" && STAGE_RANK[inferredStage] < STAGE_RANK.cross_sell_offered) {
    const keywords = Array.isArray(intent.filters?.keywords)
      ? (intent.filters!.keywords as unknown[]).map((k) => String(k).toLowerCase())
      : [];
    const isHob = keywords.includes("hob") || /\b(hob|burner)\b/i.test(message);
    const isChimney = keywords.includes("chimney") || /\bchimney\b/i.test(message);
    if (isHob && !ctx.declinesRefinement && !userMentionsHobType(message, history)) {
      return {
        question: "Do you prefer a gas or induction hob, and how many burners (3 / 4 / 5)?",
        category: "clarification",
        stage: "preferences_collected",
        shouldOfferLead: false,
        shouldRequestContact: false,
        rationale: "hob_type",
      };
    }
    if (isHob) {
      return {
        question: "Would you like a matching Carysil chimney suggestion to pair with the hob?",
        category: "cross_sell",
        stage: "cross_sell_offered",
        shouldOfferLead: false,
        shouldRequestContact: false,
        rationale: "hob_cross_sell_chimney",
      };
    }
    if (isChimney) {
      return {
        question: "Would you like a matching hob suggestion to go with this chimney?",
        category: "cross_sell",
        stage: "cross_sell_offered",
        shouldOfferLead: false,
        shouldRequestContact: false,
        rationale: "chimney_cross_sell_hob",
      };
    }
  }

  if (category === "Combo" && !ctx.declinesRefinement && STAGE_RANK[inferredStage] < STAGE_RANK.cross_sell_offered) {
    return {
      question: "Would you like me to fine-tune the combo by size, finish, or budget?",
      category: "clarification",
      stage: "preferences_collected",
      shouldOfferLead: false,
      shouldRequestContact: false,
      rationale: "combo_refine",
    };
  }

  if (
    STAGE_RANK[inferredStage] < STAGE_RANK.dealer_offered &&
    salesIntent.lead_probability >= 0.45
  ) {
    return {
      question:
        "Would you like me to connect you with a Carysil dealer near your city to check pricing and availability?",
      category: "dealer",
      stage: "dealer_offered",
      shouldOfferLead: true,
      shouldRequestContact: false,
      rationale: "buying_intent_fallback",
    };
  }

  if (STAGE_RANK[inferredStage] < STAGE_RANK.cross_sell_offered) {
    return {
      question: "Would you like to explore matching faucets or accessories as well?",
      category: "cross_sell",
      stage: "cross_sell_offered",
      shouldOfferLead: false,
      shouldRequestContact: false,
      rationale: "generic_cross_sell",
    };
  }

  if (hasRecommendations && ctx.declinesRefinement) {
    // User already declined to narrow down — offer a neutral next step (dealer connect)
    // instead of another category-specific filter question (bowl type, finish, etc.),
    // which is exactly the loop the pre-catalogue clarification guard exists to prevent.
    return {
      question: "Would you like me to connect you with a Carysil dealer near your city for pricing and availability?",
      category: "dealer",
      stage: "recommendations_shown",
      shouldOfferLead: true,
      shouldRequestContact: false,
      rationale: "declined_refinement_neutral_followup",
    };
  }

  if (hasRecommendations) {
    return {
      question: defaultFollowupAfterRecommendations(category, recommendations),
      category: "clarification",
      stage: "preferences_collected",
      shouldOfferLead: false,
      shouldRequestContact: false,
      rationale: "default_followup",
    };
  }

  return {
    question: null,
    category: "none",
    stage: inferredStage,
    shouldOfferLead: false,
    shouldRequestContact: false,
    rationale: "stage_advanced",
  };
}

/** Should we explicitly ask for phone / email / city? Only on strong signals. */
export function shouldAskLeadQuestion(ctx: FollowupContext): boolean {
  if (ctx.contactInfo.phone || ctx.contactInfo.email) return false;
  const { salesIntent, message } = ctx;
  if (
    isExplicitContactRequest(message) ||
    isExplicitQuotationRequest(message) ||
    isInstallationRequest(message)
  )
    return true;
  if (salesIntent.intent === "contact_request" || salesIntent.intent === "quotation_request") return true;
  if (salesIntent.intent === "dealer_inquiry" && Boolean(userHasCity(ctx.contactInfo, salesIntent))) return true;
  // High probability alone is not enough — it was firing on normal product browse and hid AI follow-ups.
  if (salesIntent.lead_probability >= 0.82 && salesIntent.signals.includes("contact_shared")) return true;
  return false;
}

/** Lightweight wrapper around extractContactInfo to expose a single import point. */
export function extractLeadData(
  message: string,
  salesIntent: DetectedSalesIntent | undefined,
  history: ConversationMessage[] = []
): ContactInfo {
  return extractContactInfo(message, salesIntent, history);
}

/**
 * True when the assistant explicitly asked the user for contact details (not passive dealer copy).
 * Used for lead capture routing and for deciding when to persist name/phone/email from user text.
 */
export function recentlyAskedForLeadDetails(history: ConversationMessage[]): boolean {
  return history.slice(-8).some((entry) => {
    if (entry.role !== "assistant") return false;
    const c = entry.content.toLowerCase();
    return (
      /\b(share|send|give)\s+(us\s+)?(your|me)\s+(city|phone|email|number|contact|details)\b/.test(c) ||
      /\b(may\s+i\s+have|could\s+i\s+get|please\s+share)\s+(your\s+)?(city|phone|email|number)\b/.test(c) ||
      /\b(your\s+city\s+and\s+phone|your\s+phone\s+and\s+city|city\s+and\s+phone\s+number)\b/.test(c) ||
      /\bcontact\s+you\s+with\s+.*\b(your|share)\b/.test(c) ||
      /\bso\s+a\s+carysil\s+partner\s+can\b/.test(c) ||
      /\b(may\s+i\s+have\s+your\s+name|your\s+name\s+and\s+(mobile|phone)|name\s+and\s+(mobile|phone))\b/.test(c) ||
      /\bcarysil\s+specialist\s+to\s+follow\s+up\b/.test(c) ||
      /\bbefore\s+i\s+share\s+personalised\b/.test(c) ||
      /\bcould\s+you\s+share\s+your\s+name\s+and\s+mobile\b/.test(c)
    );
  });
}

/** User may correct or add details in the turn after we thanked them. */
export function recentlyAssistantAcknowledgedLeadDetails(history: ConversationMessage[]): boolean {
  return history.slice(-5).some((entry) => {
    if (entry.role !== "assistant") return false;
    const c = entry.content.toLowerCase();
    return (
      /\bhave\s+your\s+details\b/.test(c) ||
      /\bhave\s+shared\s+your\s+details\b/.test(c) ||
      /\bshared\s+your\s+details\s+with\s+the\s+carysil\s+team\b/.test(c) ||
      /\bcarysil\s+team\s+will\s+reach\s+out\b/.test(c) ||
      /\breach\s+out\s+shortly\b/.test(c)
    );
  });
}

export function recentlyAskedCityAndPhoneForPartner(history: ConversationMessage[]): boolean {
  return history.slice(-8).some((entry) => {
    if (entry.role !== "assistant") return false;
    const c = entry.content.toLowerCase();
    return /\bcity\s+and\s+phone\b/.test(c) || /\bphone\s+number,\s+and\s+our\s+carysil\s+partner\b/.test(c);
  });
}

/** Dealer flow asks for city alone (no phone) — e.g. "Which city or state are you in?" */
export function recentlyAskedForDealerCity(history: ConversationMessage[]): boolean {
  return history.slice(-8).some((entry) => {
    if (entry.role !== "assistant") return false;
    return /which\s+city\s+or\s+state\s+are\s+you\s+in/i.test(entry.content);
  });
}

/** Only persist PII from the user's message when we're in an explicit capture or confirmation window. */
export function shouldPersistContactFieldsFromUserTurn(history: ConversationMessage[]): boolean {
  return (
    recentlyAskedForLeadDetails(history) ||
    recentlyAskedNameAndPhoneCapture(history) ||
    recentlyAssistantAcknowledgedLeadDetails(history) ||
    recentlyAskedCityAndPhoneForPartner(history) ||
    recentlyAskedForDealerCity(history)
  );
}

function clarificationQuestion(
  category: ProductCategory,
  message: string,
  history: ConversationMessage[]
): string | null {
  if (category === "Sink" && !userHasSizeOrBowlPreference(message, history)) {
    return "Would you like a single-bowl or double-bowl sink, and any size preference (45 / 60 / 75 cm)?";
  }
  if (category === "Faucet" && !userHasFinishOrColor(message, history)) {
    return "Any preferred finish — chrome, matte black, or PVD — and deck-mount or wall-mount?";
  }
  if (category === "Disposer") {
    return "How many people are in the household, and would you like installation help too?";
  }
  if (category === "Appliance") {
    const kitchenSize = inferKitchenSize(message, history);
    if (/\bhob\b|\bburner\b/i.test(message) && !userMentionsHobType(message, history)) {
      return "Do you prefer gas or induction, and how many burners (3 / 4 / 5)?";
    }
    if (kitchenSize === "compact") {
      return "For a compact kitchen, would a 60 cm option work, or do you have a different size constraint?";
    }
    if (kitchenSize === "large") {
      return "For a larger kitchen, would you prefer a 75 cm or 90 cm option?";
    }
  }
  if (category === "Combo") {
    return "Any preferred size, finish, or budget for the combo?";
  }
  return null;
}

/** Assistant copy that asks for name + phone after product suggestions (used for dedupe + lead routing). */
const NAME_PHONE_CAPTURE_SNIPPET =
  "may I have your name and mobile number";

export function recentlyAskedNameAndPhoneCapture(history: ConversationMessage[]): boolean {
  return history.slice(-8).some((entry) => {
    if (entry.role !== "assistant") return false;
    const c = entry.content.toLowerCase();
    return (
      c.includes("may i have your name") ||
      c.includes("could you share your name") ||
      /\byour\s+name\s+and\s+(mobile|phone)\b/.test(c) ||
      /\bname\s+and\s+(mobile|phone)\s+number\b/.test(c) ||
      /\bbefore\s+i\s+share\s+personalised\b/.test(c)
    );
  });
}

/** Second chip after product recommendations: soft ask for name + mobile (one sentence). */
export function buildContactCaptureFollowupChip(
  primaryFollowup: string | null,
  contactInfo: ContactInfo,
  _history: ConversationMessage[]
): string | null {
  if (contactInfo.phone || contactInfo.email) return null;
  if (
    primaryFollowup &&
    /\b(may\s+i\s+have\s+your\s+name|your\s+name\s+and|mobile\s+number|phone\s+number|city\s+and\s+phone|carysil\s+partner\s+can)\b/i.test(
      primaryFollowup
    )
  ) {
    return null;
  }
  return `If you'd like a Carysil specialist to follow up with quotes or dealer options, ${NAME_PHONE_CAPTURE_SNIPPET}?`;
}

export function userMessageHasPhoneOrEmail(message: string): boolean {
  return (
    /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(message) || /(?:\+91[\s-]?)?[6-9]\d{9}\b/.test(message.trim())
  );
}

export function deriveInterestedProducts(
  recommendations: RecommendationLite[]
): InterestedProduct[] {
  const seen = new Set<string>();
  const list: InterestedProduct[] = [];
  for (const rec of recommendations) {
    const key = rec.id || rec.name;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    list.push({
      id: rec.id,
      name: rec.name,
      category: rec.category,
      shown_at: new Date().toISOString(),
    });
  }
  return list;
}

export type LeadUpdateInput = {
  sessionId: string;
  contactInfo: ContactInfo;
  salesIntent: DetectedSalesIntent;
  interestedProductLabel?: string | null;
  recommendations?: RecommendationLite[];
  stage?: FollowupStage;
  recommendationsShown?: number;
  dealersShown?: number;
  extraScore?: number;
  intentConfidence?: number | null;
  buyingConfidence?: number | null;
  funnelStage?: string | null;
  /** Dealer this lead was routed to (dealers.id), when a location match is found. */
  assignedDealerId?: string | null;
};

/** Single entry point used everywhere we want to upsert a lead. */
export async function updateLeadRecord(input: LeadUpdateInput): Promise<void> {
  const baseDelta = calculateLeadScore({
    salesIntent: input.salesIntent,
    contactInfo: input.contactInfo,
    recommendationsShown: input.recommendationsShown,
    dealersShown: input.dealersShown,
  });
  const update: LeadUpdate = {
    ...input.contactInfo,
    intent: input.salesIntent.intent,
    interestedProduct: input.interestedProductLabel ?? null,
    interestedProducts: input.recommendations ? deriveInterestedProducts(input.recommendations) : undefined,
    followupStage: input.stage,
    scoreDelta: baseDelta + (input.extraScore ?? 0),
    intentConfidence: input.intentConfidence ?? null,
    buyingConfidence: input.buyingConfidence ?? null,
    funnelStage: input.funnelStage ?? null,
    assignedDealerId: input.assignedDealerId ?? null,
  };
  await updateLead(input.sessionId, update);
  // Monotonic funnel ratchet runs after every lead upsert. Best-effort —
  // a failed funnel recompute must never propagate into the request path.
  void recomputeFunnelStage(input.sessionId, `stage:${input.stage ?? "unknown"}`).catch((err) =>
    console.error("[funnel] auto-recompute failed", err)
  );
  // Auto-convert: a lead-gen chatbot has no checkout, so "converted" means
  // handed off to sales — full contact captured plus a dealer/quote ask.
  // Checks the canonical stored contact (not just this turn's delta, which
  // may be city-only when PII persistence isn't allowed this turn).
  if (input.salesIntent.intent === "dealer_inquiry" || input.salesIntent.intent === "quotation_request") {
    void getLeadContactSnapshot(input.sessionId)
      .then((snapshot) => {
        if (snapshot.phone || snapshot.email) {
          return markConverted(input.sessionId, `auto:${input.salesIntent.intent}`);
        }
      })
      .catch((err) => console.error("[funnel] auto-convert failed", err));
  }
}
