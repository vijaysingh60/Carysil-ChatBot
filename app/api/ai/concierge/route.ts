import { NextResponse } from "next/server";
import productsData from "@/data/products.json";
import dealersData from "@/data/dealers.json";
import { callAI } from "@/lib/ai";
import { planClarificationWithGPT } from "@/lib/conciergeDialogPlanner";
import { detectIntent, type IntentResult, type ProductCategory } from "@/lib/concierge";
import {
  buildIntentClarificationFollowups,
  buildRecommendationFollowups,
  getProductClarificationMessage,
  shouldAskBeforeProductRecommendations,
} from "@/lib/intentFollowupChips";
import {
  generateFollowupQuestion,
  shouldAskLeadQuestion,
  extractLeadData,
  updateLeadRecord,
  deriveInterestedProducts,
  defaultFollowupAfterRecommendations,
  recentlyAskedForLeadDetails,
  recentlyAskedNameAndPhoneCapture,
  shouldPersistContactFieldsFromUserTurn,
  userMessageHasPhoneOrEmail,
  type FollowupResult,
  type RecommendationLite,
} from "@/lib/followupEngine";
import { detectSalesIntent } from "@/lib/intentDetection";
import {
  clearDeferredProductQuery,
  getDeferredProductQuery,
  setDeferredProductQuery,
} from "@/services/deferredRecommendationService";
import { searchSimilarProducts } from "@/lib/vectorSearch";
import { storeAnalyticsEvent, storeAnalyticsEventAsync } from "@/services/analyticsService";
import {
  calculateLeadScore,
  contactInfoForLeadDatabaseUpdate,
  getLeadContactSnapshot,
  mergeContactForRuntime,
} from "@/services/leadService";
import { createSession, storeChatEvent, storeChatEventAsync } from "@/services/sessionService";
import { upsertVisitor } from "@/services/visitorService";
import { ingestUserTurn } from "@/services/conversationStateService";
import { buildConciergePrompt } from "@/lib/promptBuilder";
import { flush as flushEventBus } from "@/lib/eventBus";
import {
  logRetrieval,
  logShown,
} from "@/services/recommendationAnalyticsService";
import { recordSignalsFromTurn } from "@/services/leadScoringService";
import { generateNextQuestion } from "@/lib/followupPlanner";
import type { FunnelStage } from "@/types/funnel";
import type { RecommendationFollowupReason } from "@/types/recommendationEvent";
import type { ChatEventType, ContactInfo } from "@/types/lead";
import type { ConversationState } from "@/types/conversationState";

type Dealer = {
  id: string;
  name: string;
  city: string;
  state: string;
  products_supported: string[];
  contact_email: string;
  phone: string;
};

const allDealers = dealersData as Dealer[];
const knownDealerStates = new Set(allDealers.map((dealer) => normalizeLoc(dealer.state)));

/** Normalize location string for fuzzy match (e.g. Bengaluru → bangalore, NCR → delhi/gurgaon/noida) */
function normalizeLoc(s: string): string {
  const lower = s.toLowerCase().trim();
  const map: Record<string, string> = {
    bangalore: "bangalore",
    bengaluru: "bangalore",
    bombay: "mumbai",
    gurgaon: "gurgaon",
    gurugram: "gurgaon",
    ncr: "gurgaon",
    "delhi ncr": "ncr",
    delhi: "delhi",
    "new delhi": "new delhi",
    noida: "noida",
    chennai: "chennai",
    madras: "chennai",
    kolkata: "kolkata",
    calcutta: "kolkata",
  };
  return map[lower] ?? lower;
}

function locationAliases(s: string): string[] {
  const normalized = normalizeLoc(s);
  if (normalized === "ncr") {
    return ["gurgaon", "noida", "new delhi", "delhi", "faridabad", "ghaziabad", "dwarka"];
  }
  return [normalized];
}

function locationMatches(candidate: string, search: string): boolean {
  return locationAliases(search).some((alias) => {
    const normalizedCandidate = normalizeLoc(candidate);
    return normalizedCandidate.includes(alias) || alias.includes(normalizedCandidate);
  });
}

function filterDealersByLocation(location: { city?: string; state?: string }): Dealer[] {
  if (!location.city && !location.state) return [];
  return allDealers.filter((d) => {
    const matchCity = location.city ? locationMatches(d.city, location.city) : false;
    const matchState = location.state ? locationMatches(d.state, location.state) : false;
    if (location.city && location.state) return matchCity || matchState;
    if (location.city) return matchCity;
    return matchState;
  });
}

function formatLocation(loc: { city?: string; state?: string }): string {
  if (loc.city && loc.state) return `${loc.city}, ${loc.state}`;
  return loc.city || loc.state || "";
}

/** One consultative follow-up after dealer cards (shown as a chip in the widget). */
function dealerFollowupQuestion(input: {
  dealerCount: number;
  cityShort: string | null;
  locationLabel: string;
  allIndia?: boolean;
}): string {
  if (input.allIndia) {
    return "Would you like help shortlisting sinks, faucets, or appliances before you contact a dealer?";
  }
  if (input.dealerCount > 0) {
    const place = input.cityShort?.trim() || input.locationLabel.trim();
    return place
      ? `Would you like tailored Carysil product suggestions to discuss when you reach out in ${place}?`
      : "Would you like tailored Carysil product suggestions to discuss when you reach out to a dealer?";
  }
  return "Would you like tailored Carysil product ideas from our catalogue for your kitchen or bathroom?";
}

function inferDealerLocationFromMessage(message: string): { city?: string; state?: string } | null {
  if (NOT_A_DEALER_CITY_REPLY.test(message)) return null;
  const nearMeMatch = message.match(/\bnear\s+me\s+(?:in|at|around)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+){0,2})\b/i);
  const match = nearMeMatch || message.match(/\b(?:in|at|from|near)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+){0,2})\b/i);
  if (!match) return null;
  const location = toTitleCaseLocation(match[1]);
  if (NOT_A_DEALER_CITY_REPLY.test(location)) return null;
  const normalized = normalizeLoc(location);
  if (knownDealerStates.has(normalized)) {
    return { state: location };
  }
  return { city: location };
}

type Product = {
  id: string;
  name: string;
  category: string;
  size?: string | null;
  style: string;
  material: string;
  price_range: string;
  description: string;
  price?: string;
  image_url?: string;
  url?: string;
  collection?: string;
};

const allProducts = productsData as Product[];
const productById = new Map<string, Product>();
for (const product of allProducts) {
  if (!productById.has(product.id)) {
    productById.set(product.id, product);
  }
}

function dedupeProductsById(products: Product[]): Product[] {
  const seen = new Set<string>();
  return products.filter((product) => {
    if (seen.has(product.id)) return false;
    seen.add(product.id);
    return true;
  });
}

function normalizeSizeToken(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "");
}

function extractCmFromText(s: string): string | null {
  const m = s.match(/\b(\d{2,3})\s*cm\b/i);
  return m ? `${m[1]}cm` : null;
}

/** Filter products by intent: categories and optional material/price_range/style */
function filterByIntent(
  intent: IntentResult
): Product[] {
  if (!intent.categories?.length) {
    return allProducts;
  }
  const f = intent.filters;
  const keywordList: string[] =
    f?.keywords == null
      ? []
      : Array.isArray(f.keywords)
        ? (f.keywords as unknown[]).map((k) => String(k))
        : [String(f.keywords)];
  // Map high-level intent categories to catalogue categories.
  // In this project, many hobs are stored under category "Hob" (not "Appliance").
  const rawCats = intent.categories as string[];
  const expanded = new Set<string>();
  const wantsChimney = keywordList.map((k) => k.toLowerCase()).includes("chimney");
  for (const c of rawCats) {
    expanded.add(c);
    if (c === "Appliance") {
      expanded.add("Hob");
      if (wantsChimney) expanded.add("Combo");
    }
  }
  let list = allProducts.filter((p) => expanded.has(p.category));
  // Narrow appliances when the user mentions a subtype (hob/burner vs dishwasher vs chimney).
  if (keywordList.length > 0 && intent.categories.length === 1 && intent.categories[0] === "Appliance") {
    const hay = (p: Product) => `${p.name} ${p.description ?? ""}`.toLowerCase();
    const kws = keywordList.map((k) => String(k).toLowerCase());
    // If user asked for hob/burner, exclude cooking ranges unless explicitly requested.
    const wantsHob = kws.includes("hob");
    const wantsCookingRange = kws.includes("cooking range");
    list = list.filter((p) => {
      const h = hay(p);
      const matchesAny = kws.some((k) => (k === "hob" ? /\bhob\b|\bburner\b|\bburners\b/.test(h) : h.includes(k)));
      if (!matchesAny) return false;
      if (wantsHob && !wantsCookingRange && /\b(cooking\s*range|freestanding\s*range|standing\s*range)\b/.test(h)) return false;
      return true;
    });
  }
  if (f?.material) {
    const m = f.material.toLowerCase();
    list = list.filter(
      (p) => p.material?.toLowerCase().includes(m) || m.split(/\s+/).some((w) => p.material?.toLowerCase().includes(w))
    );
  }
  if (f?.price_range) {
    const pr = f.price_range.toLowerCase();
    list = list.filter(
      (p) => p.price_range?.toLowerCase() === pr || p.price_range?.toLowerCase().includes(pr)
    );
  }
  if (f?.style) {
    const s = f.style.toLowerCase();
    list = list.filter(
      (p) => p.style?.toLowerCase().includes(s) || s.split(/\s+/).some((w) => p.style?.toLowerCase().includes(w))
    );
  }
  if (f?.size) {
    const sz = normalizeSizeToken(String(f.size));
    const listHasAnySize = list.some((p) => p.size != null && String(p.size).trim().length > 0);
    const filtered = list.filter((p) => {
      const direct = p.size != null ? normalizeSizeToken(String(p.size)) : "";
      const derived = extractCmFromText(`${p.name} ${p.description ?? ""}`) || "";
      const candidate = direct || derived;
      if (!candidate) return false;
      return candidate.includes(sz) || sz.includes(candidate);
    });
    // If size isn't populated on products yet, don't wipe out the whole category.
    if (filtered.length > 0 || listHasAnySize) {
      list = filtered;
    }
  }
  return list.length > 0 ? list : allProducts.filter((p) => expanded.has(p.category));
}

const RECOMMENDATION_SYSTEM = `You are AskCary — the Carysil AI shopping concierge for Carysil (carysil.com), a premium kitchen and bathroom brand. You behave like a warm, attentive boutique consultant — never like a form or FAQ bot.

You will receive:
1. The user's message and recent conversation context
2. The product category/categories they are interested in
3. A RELEVANT catalogue (already filtered to match their intent). Recommend ONLY from this catalogue.

**Recommendation rules:**
1. If the catalogue is empty or you have no good matches, say so briefly and invite them to refine (different budget / material). Set recommended_ids to [].
2. Otherwise, pick 3–4 products that best match the user's stated or implied needs (budget, material, style, size, use case). Use ONLY the "id" values from the catalogue (exact match). Aim for at least 3 recommendations when the catalogue has enough options.
3. Prefer variety: different series, sizes, or colours where relevant.
4. Reflect the user's constraints (colour, budget, style, bowl type, finish) only in a short intro — see rule 5.
5. **"message" field (critical):** The app shows **clickable product cards** with names, prices, images, and links. Your "message" must be ONLY a **brief** warm intro (1–2 short sentences, plain text). **Do NOT** list product names, model lines, dimensions, prices, or features in "message". **Do NOT** use numbered lists (1. 2. 3.), bullets, markdown (**bold**), or "Rs." / rupee amounts in "message". Never echo the catalogue — the UI renders it.
6. NEVER ask for phone, email, or address in this JSON. The app adds a separate optional line for name/mobile after your product question — keep "followup_question" strictly about products, style, or next shopping step.

**Smart follow-up rules (very important):**
After the recommendation message, ALWAYS continue the conversation naturally with ONE intelligent follow-up question in the "followup_question" field. It must:
- be a SINGLE question (not multiple stacked together),
- be CONTEXTUAL to what was just recommended (bowl type, finish, kitchen size, matching faucet, dealer help, quotation),
- feel like a premium consultant — proactive, helpful, sales-aware, never pushy,
- NOT ask for phone or email directly,
- NOT repeat a question already visible in the recent conversation.

Examples of good follow-up questions:
- "Would you prefer a single-bowl or double-bowl configuration for your kitchen?"
- "Would you like matching matte black faucet suggestions to pair with these sinks?"
- "Are you looking at a 60 cm or 75 cm size to fit your countertop?"
- "Would you like me to check Carysil dealer availability near your city?"
- "Would you like a Carysil partner to share a quick price quotation for these?"

**Response format – strict JSON only (no markdown, no backticks):**
{
  "asking_clarification": false,
  "message": "One or two short sentences only — theme and reassurance. No product names, prices, or lists (cards show those).",
  "recommended_ids": ["id1", "id2", "id3", "id4"],
  "followup_question": "ONE contextual follow-up question to continue the conversation naturally."
}

- Use only ids that appear in the catalogue you were given.
- followup_question must be one sentence ending with "?".`;

/** Simple greeting – respond with a friendly Carysil welcome, no dealer push. */
const GREETING_PATTERN = /^(hi|hello|hey|hi there|hello there|good\s+(morning|afternoon|evening)|howdy|greetings?|thanks|thank\s+you|ok|okay)\s*[\.\!]?\s*$/i;

type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

function sanitizeHistory(rawHistory: unknown): ConversationMessage[] {
  if (!Array.isArray(rawHistory)) return [];
  return rawHistory
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const role = (entry as { role?: unknown }).role;
      const content = String((entry as { content?: unknown }).content || "").trim();
      if ((role !== "user" && role !== "assistant") || !content) return null;
      return { role, content };
    })
    .filter((entry): entry is ConversationMessage => entry !== null)
    .slice(-8);
}

function formatPlannerHistory(history: ConversationMessage[]): string {
  return history
    .slice(-6)
    .map((entry) => `${entry.role === "user" ? "User" : "AskCary"}: ${entry.content}`)
    .join("\n");
}

function toTitleCaseLocation(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function inferProductContextFromText(text: string): { category: ProductCategory; keywords?: string[] } | null {
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

function inferRecentProductContext(history: ConversationMessage[]): { category: ProductCategory; keywords?: string[] } | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].role !== "user") continue;
    const context = inferProductContextFromText(history[index].content);
    if (context) return context;
  }

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const context = inferProductContextFromText(history[index].content);
    if (context) return context;
  }
  return null;
}

/**
 * Only treat history as "waiting for a place name" when the **latest** assistant turn asked for it.
 * Scanning the last 6 messages caused product replies (e.g. chip "Full Range") to pair with an old
 * "which city?" line and get misrouted as dealer_intent with city "Full Range".
 */
function hasRecentExplicitDealerLocationAsk(history: ConversationMessage[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "assistant") continue;
    const c = history[i].content;
    return (
      /\b(which\s+city|what\s+city|city\s+or\s+state|your\s+city|your\s+state|pincode|postal\s+code)\b/i.test(
        c
      ) ||
      /\b(where\s+are\s+you|where\s+do\s+you\s+live|location\s+in)\b/i.test(c) ||
      /\bfind\s+(a\s+)?(carysil\s+)?dealer\b/i.test(c) ||
      /\bwhere\s+to\s+buy\b/i.test(c) ||
      /\bI'll\s+find\s+carysil\s+dealers\b/i.test(c)
    );
  }
  return false;
}

function isOpenEndedFollowup(message: string): boolean {
  return /^(any|anything|any\s+one|any\s+of\s+them|any\s+(?:size|type|style|budget|finish|colour|color)|no\s+(?:size|type|style|budget|finish|colour|color)\s+preference|no\s+preference|no\s+preferences|does(?:n'?t)?\s+matter|show\s+me|show\s+options|show\s+some|yes|yeah|yep|ok|okay|whatever|whatever\s+is\s+best|you\s+choose|recommend|recommend\s+some|best\s+one|explore\s+(?:the\s+)?full\s+range)(?:\s+(sink|sinks|faucet|faucets|tap|taps|hob|hobs|chimney|chimneys|dishwasher|dishwashers|disposer|disposers|combo|combos|accessory|accessories|appliance|appliances))?[\.\!]*$/i.test(
    message.trim()
  );
}

function inferFollowupProductFilters(
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

    // Short replies after a hob size question ("larger or compact?") — keep Appliance+hob from history via resolveFollowupIntent.
    const hobContinuation =
      Boolean(context.keywords?.some((k) => /\b(hob|burner)\b/i.test(k))) ||
      /\b(built[- ]?in\s+hob|hob\s+size)\b/i.test(lower);
    if (hobContinuation) {
      const showSizeRefinement =
        /\b(show\s+(me\s+)?(the\s+)?)?(larger|bigger|big(\s+one)?|widest|the\s+biggest|max(?:imum)?|full[-\s]?width)\b/i.test(
          lower
        ) ||
        /\b(show\s+(me\s+)?(the\s+)?)?(smaller|more\s+compact|compact(\s+(one|option|size))?|slim(line)?|the\s+smallest)\b/i.test(
          lower
        ) ||
        /\b(medium|mid[-\s]?size|in\s+between)\b/i.test(lower) ||
        /^(ok|okay|yes|yeah|yep|sure)\s*,?\s*(show\s+)?(the\s+)?(larger|bigger|smaller|compact)\b/i.test(lower.trim());
      if (showSizeRefinement) {
        keywords.push("size");
        if (
          /\b(larger|bigger|big(\s+one)?|widest|the\s+biggest|max(?:imum)?|full[-\s]?width|90\s*cm)\b/i.test(lower) ||
          /^(ok|okay|yes|yeah|yep|sure)\s*,?\s*(show\s+)?(the\s+)?(larger|bigger)\b/i.test(lower.trim())
        ) {
          return {
            keywords: Array.from(new Set([...(context.keywords || []), ...keywords, "hob"])),
            size: "90 cm",
          };
        }
        if (
          /\b(smaller|more\s+compact|compact(\s+(one|option|size))?|slim(line)?|the\s+smallest|60\s*cm)\b/i.test(lower) ||
          /^(ok|okay|yes|yeah|yep|sure)\s*,?\s*(show\s+)?(the\s+)?compact\b/i.test(lower.trim())
        ) {
          return {
            keywords: Array.from(new Set([...(context.keywords || []), ...keywords, "hob"])),
            size: "60 cm",
          };
        }
        if (/\b(medium|mid[-\s]?size|in\s+between|75\s*cm)\b/i.test(lower)) {
          return {
            keywords: Array.from(new Set([...(context.keywords || []), ...keywords, "hob"])),
            size: "75 cm",
          };
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

function looksLikeNaturalLanguageShoppingRequest(message: string): boolean {
  const t = message.trim().toLowerCase();
  if (/\b[6-9]\d{9}\b/.test(t)) return true;
  if (/\b(i|we)\s+(need|want|would\s+like|am\s+looking|are\s+looking|just\s+need|just\s+want)\b/.test(t)) return true;
  if (/\b(looking\s+for|help\s+(with|me)|show\s+me|can\s+you|could\s+you)\b/.test(t)) return true;
  if (/\b(full|new|complete|entire|modular|whole)\s+(kitchen|bathroom|bath)\b/.test(t)) return true;
  if (/\b(kitchen|bathroom)\s+(package|project|reno|renovation|setup|design|for\s+my)\b/.test(t)) return true;
  return false;
}

/** Product UI / chips (e.g. "Full Range") — not a place name; must not become dealer city. */
const NOT_A_DEALER_CITY_REPLY =
  /\b(explore\s+(?:the\s+)?full\s+range|full\s+range(?:\s+of)?|show\s+(?:me\s+)?(?:the\s+)?full\s+range)\b/i;

function isLikelyLocationReply(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length < 2 || trimmed.length > 60) return false;
  if (NOT_A_DEALER_CITY_REPLY.test(trimmed)) return false;
  if (looksLikeNaturalLanguageShoppingRequest(trimmed)) return false;
  // Product browse (e.g. "show me hobs") must not be treated as a city after a generic "dealer" mention in the welcome.
  if (inferProductContextFromText(trimmed)) return false;
  if (/^\d{5,6}$/.test(trimmed)) return true;
  if (/[?]/.test(trimmed)) return false;
  if (
    /\b(sinks?|faucets?|taps?|hobs?|chimneys?|dishwashers?|disposers?|combos?|accessories?|appliances?|burners?|dealers?|stores?|showrooms?)\b/i.test(
      trimmed
    )
  ) {
    return false;
  }
  if (/\bkitchen\b|\bbathroom\b|\bhome\b|\bhouse\b|\breno\b|\brenovation\b/i.test(trimmed)) return false;
  return /^[a-zA-Z][a-zA-Z\s.-]*$/.test(trimmed);
}

function resolveFollowupIntent(message: string, history: ConversationMessage[]): IntentResult | null {
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

  /** User is answering disposer clarification (household size, noise, install) — keep Disposer and skip re-clarification. */
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

function getSearchCategories(message: string, intent: IntentResult): string[] | undefined {
  if (!intent.categories?.length) return undefined;
  if (intent.categories.includes("Combo") && /\bcombo|combos\b/i.test(message)) {
    return ["Combo"];
  }
  return intent.categories;
}

function enrichProductIntent(message: string, intent: IntentResult): IntentResult {
  if (intent.dealer_intent) return intent;
  const inferred = inferProductContextFromText(message);
  if (!inferred?.keywords?.length) return intent;

  const existingKeywords = Array.isArray(intent.filters?.keywords)
    ? intent.filters.keywords
    : intent.filters?.keywords
      ? [String(intent.filters.keywords)]
      : [];

  return {
    ...intent,
    categories: intent.categories.length > 0 ? intent.categories : [inferred.category],
    filters: {
      ...intent.filters,
      keywords: Array.from(new Set([...existingKeywords, ...inferred.keywords])),
    },
  };
}

/** Phone/email in this message, or city clearly typed by the user (not product browse like "sure show me products"). */
function userProvidedLeadSignals(message: string, contactFromMessageOnly: ContactInfo): boolean {
  const trimmed = message.trim();
  if (/\b[6-9]\d{9}\b/.test(trimmed) || /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(trimmed)) return true;
  if (contactFromMessageOnly.phone || contactFromMessageOnly.email) return true;
  if (contactFromMessageOnly.city && trimmed.length <= 80) {
    const city = contactFromMessageOnly.city.toLowerCase();
    if (new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(trimmed)) return true;
  }
  // Short place-only replies (e.g. "Hyderabad") after a lead prompt — exclude product / affirmation chatter.
  if (isLikelyLocationReply(trimmed)) {
    const lower = trimmed.toLowerCase();
    if (
      /\b(sure|yes|yeah|ok|please|show|want|need|give|tell|me|some|any|product|products|sink|faucets?|taps?|dealer|quote|price)\b/.test(
        lower
      )
    ) {
      return false;
    }
    return true;
  }
  return false;
}

function recentlyOfferedDealerConnect(history: ConversationMessage[]): boolean {
  return history
    .slice(-4)
    .some((message) =>
      message.role === "assistant" &&
      /\b(connect you|dealer near|carysil dealer|team can assist|would you like me to connect)\b/i.test(message.content)
    );
}

function isAffirmativeLeadReply(message: string): boolean {
  return /^(yes|yeah|yep|sure|ok|okay|please|connect me|call me|sounds good|do it)[\s.!]*$/i.test(message.trim());
}

function hasContactInfo(info: ContactInfo): boolean {
  return Boolean(info.name || info.phone || info.email || info.city);
}

/** Indian mobile: optional +91, then 6–9 and 9 more digits. */
function hasValidIndianMobileInText(text: string): boolean {
  return /(?:\+91[\s-]?)?[6-9]\d{9}\b/.test(text);
}

/**
 * After we asked for name+mobile and recommendations are deferred, detect a reply that is
 * clearly trying to share contact (not a new product question) — even if the number is invalid.
 */
function looksLikeDeferredContactCaptureReply(
  message: string,
  history: ConversationMessage[],
  hasDeferred: boolean
): boolean {
  if (!hasDeferred || !recentlyAskedForLeadDetails(history)) return false;
  const p = extractLeadData(message, undefined, history);
  if (p.name || p.email || p.phone) return true;
  const digits = message.replace(/\D/g, "");
  if (digits.length >= 7) return true;
  const t = message.trim();
  if (t.length < 2 || t.length > 45) return false;
  if (!/^[A-Za-z][a-zA-Z\s.'-]*$/.test(t)) return false;
  if (t.split(/\s+/).filter(Boolean).length > 4) return false;
  if (
    /\b(sink|sinks|faucet|faucets|taps?|hob|hobs|chimney|disposer|kitchen|bathroom|show|want|need|budget|price|dealer|combo|appliance)\b/i.test(
      t
    )
  ) {
    return false;
  }
  return true;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const userRawMessage = String(body?.message || "").trim();
    const history = sanitizeHistory(body?.history);
    const incomingVisitorId =
      typeof body?.visitorId === "string" && body.visitorId.trim().length > 0
        ? body.visitorId.trim()
        : undefined;
    const activeSessionId = await createSession({
      sessionId: typeof body?.sessionId === "string" ? body.sessionId : undefined,
      source: typeof body?.source === "string" ? body.source : "chat_widget",
      deviceType: typeof body?.deviceType === "string" ? body.deviceType : undefined,
      visitorId: incomingVisitorId,
    });
    if (incomingVisitorId) {
      // Best-effort, non-blocking visitor row touch.
      void upsertVisitor(incomingVisitorId);
    }
    if (!userRawMessage) {
      return NextResponse.json(
        { error: "Missing message", sessionId: activeSessionId },
        { status: 400 }
      );
    }

    let leadSnapshotForWrite = await getLeadContactSnapshot(activeSessionId);
    const allowContactPersist = shouldPersistContactFieldsFromUserTurn(history);

    const deferredQuery = await getDeferredProductQuery(activeSessionId);
    const completingDeferred =
      Boolean(deferredQuery) &&
      recentlyAskedForLeadDetails(history) &&
      hasContactInfo(extractLeadData(userRawMessage, undefined, history)) &&
      (() => {
        const contactOnly = extractLeadData(userRawMessage, undefined, []);
        const afterNamePhoneAsk = recentlyAskedNameAndPhoneCapture(history);
        const leadSignalsOk = afterNamePhoneAsk
          ? Boolean(
              contactOnly.phone || contactOnly.email || userMessageHasPhoneOrEmail(userRawMessage)
            )
          : userProvidedLeadSignals(userRawMessage, contactOnly);
        return leadSignalsOk;
      })();
    const pipelineMessage = completingDeferred && deferredQuery ? deferredQuery : userRawMessage;

    // High-volume per-turn analytics row — batched via the async event bus.
    storeChatEventAsync({
      sessionId: activeSessionId,
      role: "user",
      message: userRawMessage,
      eventType: "user_message",
      metadata: { historyCount: history.length, completingDeferred, deferredQuery: Boolean(deferredQuery) },
    });

    // Structured AI memory: extract slots from the latest user turn and merge
    // into conversation_state. Always best-effort — a failure must never block
    // the rest of the pipeline. The returned memory is used downstream by the
    // prompt builder (Part C) and the follow-up planner (Part F).
    let memory: ConversationState | null = null;
    let memoryIntentConfidence: number | null = null;
    let memoryBuyingConfidence: number | null = null;
    try {
      const ingest = await ingestUserTurn(activeSessionId, userRawMessage, history);
      memory = ingest.memory;
      if (typeof ingest.extraction.intentConfidence === "number") {
        memoryIntentConfidence = ingest.extraction.intentConfidence;
      }
      if (typeof ingest.extraction.buyingConfidence === "number") {
        memoryBuyingConfidence = ingest.extraction.buyingConfidence;
      }
    } catch (memoryError) {
      console.error("[concierge] memory ingest failed", memoryError);
    }

    if (
      deferredQuery &&
      recentlyAskedForLeadDetails(history) &&
      !completingDeferred &&
      !hasValidIndianMobileInText(userRawMessage) &&
      looksLikeDeferredContactCaptureReply(userRawMessage, history, true)
    ) {
      const partial = extractLeadData(userRawMessage, undefined, history);
      const digits = userRawMessage.replace(/\D/g, "");
      const wrongOrPlaceholderMobile = digits.length >= 10;
      if (partial.name) {
        const salesIntentEarly = detectSalesIntent(userRawMessage, undefined, history);
        await updateLeadRecord({
          sessionId: activeSessionId,
          contactInfo: contactInfoForLeadDatabaseUpdate(
            { name: partial.name },
            leadSnapshotForWrite,
            true
          ),
          salesIntent: salesIntentEarly,
          stage: "lead_requested",
          extraScore: 0,
        });
        leadSnapshotForWrite = await getLeadContactSnapshot(activeSessionId);
      }
      const nameFrag = partial.name ? `Thanks, ${partial.name}. ` : "";
      const reply = wrongOrPlaceholderMobile
        ? `${nameFrag}That number doesn't look like a valid Indian mobile (10 digits starting with 6, 7, 8, or 9). Please send it again — for example: 9876543210.`
        : `${nameFrag}Please share your 10-digit Indian mobile number (starting with 6–9) so I can show your catalogue recommendations.`;
      const trimmed = reply.trim();
      await storeChatEvent({
        sessionId: activeSessionId,
        role: "assistant",
        message: trimmed,
        eventType: "assistant_message",
        metadata: { followupStage: "lead_requested", invalidOrMissingMobile: true },
      });
      return NextResponse.json({
        result: trimmed,
        recommendations: [],
        dealers: [],
        reasoning: null,
        aiUsed: true,
        error: undefined,
        followups: [],
        assistantMessages: [{ result: trimmed, dealers: [], aiUsed: true }],
        sessionId: activeSessionId,
      });
    }

    const earlyContactInfo = extractLeadData(userRawMessage, undefined, history);
    const contactFromUserMessageOnly = extractLeadData(userRawMessage, undefined, []);
    const afterNamePhoneAsk = recentlyAskedNameAndPhoneCapture(history);
    const leadSignalsOk = afterNamePhoneAsk
      ? Boolean(
          contactFromUserMessageOnly.phone ||
            contactFromUserMessageOnly.email ||
            userMessageHasPhoneOrEmail(userRawMessage)
        )
      : userProvidedLeadSignals(userRawMessage, contactFromUserMessageOnly);
    if (recentlyAskedForLeadDetails(history) && hasContactInfo(earlyContactInfo) && leadSignalsOk) {
      const salesIntent = detectSalesIntent(userRawMessage, undefined, history);
      await updateLeadRecord({
        sessionId: activeSessionId,
        contactInfo: contactInfoForLeadDatabaseUpdate(earlyContactInfo, leadSnapshotForWrite, true),
        salesIntent,
        stage: "lead_captured",
        extraScore: 5,
      });
      leadSnapshotForWrite = await getLeadContactSnapshot(activeSessionId);
      if (!completingDeferred) {
        await storeChatEvent({
          sessionId: activeSessionId,
          role: "assistant",
          message: "Thanks, I have shared your details with the Carysil team.",
          eventType: "assistant_message",
          metadata: { leadCaptured: true, followupStage: "lead_captured" },
        });
      }
      await storeChatEvent({
        sessionId: activeSessionId,
        role: "system",
        message: "Lead captured",
        eventType: "lead_captured",
        metadata: earlyContactInfo,
      });
      await storeAnalyticsEvent({
        sessionId: activeSessionId,
        query: userRawMessage,
        detectedIntent: salesIntent.intent,
        category: salesIntent.category,
        budgetType: salesIntent.budget_type,
        city: earlyContactInfo.city || salesIntent.city,
        eventType: "lead_captured",
        metadata: {
          followupStage: "lead_captured",
          hasPhone: Boolean(earlyContactInfo.phone),
          hasEmail: Boolean(earlyContactInfo.email),
          hasCity: Boolean(earlyContactInfo.city),
        },
      });
      if (!completingDeferred) {
        return NextResponse.json({
          result: "Thanks, I have your details. Our Carysil team will reach out shortly with pricing, availability, or dealer support.",
          recommendations: [],
          dealers: [],
          reasoning: null,
          aiUsed: true,
          error: undefined,
          sessionId: activeSessionId,
        });
      }
      await clearDeferredProductQuery(activeSessionId);
    }

    if (recentlyOfferedDealerConnect(history) && isAffirmativeLeadReply(userRawMessage)) {
      const salesIntent = detectSalesIntent(userRawMessage, undefined, history);
      const reply = "Great — please share your city and phone number, and our Carysil partner can help you with availability, pricing, and the nearest dealer.";
      await updateLeadRecord({
        sessionId: activeSessionId,
        contactInfo: {},
        salesIntent,
        stage: "lead_requested",
        extraScore: 2,
      });
      await storeChatEvent({
        sessionId: activeSessionId,
        role: "assistant",
        message: reply,
        eventType: "assistant_message",
        metadata: { leadPrompted: true, followupStage: "lead_requested" },
      });
      await storeChatEvent({
        sessionId: activeSessionId,
        role: "system",
        message: "Lead details requested",
        eventType: "lead_prompted",
        metadata: { reason: "user_accepted_dealer_connect" },
      });
      await storeAnalyticsEvent({
        sessionId: activeSessionId,
        query: userRawMessage,
        detectedIntent: salesIntent.intent,
        category: salesIntent.category,
        budgetType: salesIntent.budget_type,
        city: salesIntent.city,
        eventType: "lead_prompted",
        metadata: { reason: "user_accepted_dealer_connect" },
      });
      return NextResponse.json({
        result: reply,
        recommendations: [],
        dealers: [],
        reasoning: null,
        aiUsed: true,
        error: undefined,
        sessionId: activeSessionId,
      });
    }

    // Greeting → friendly Carysil welcome and balanced help options (no dealer emphasis)
    if (GREETING_PATTERN.test(userRawMessage)) {
      const reply = "Hi! I'm AskCary, your Carysil assistant. I can help you with product recommendations (sinks, faucets, disposers, appliances), finding a dealer near you, or installation support. What would you like help with?";
      const salesIntent = detectSalesIntent(userRawMessage, undefined, history);
      await storeChatEvent({
        sessionId: activeSessionId,
        role: "assistant",
        message: reply,
        eventType: "assistant_message",
        metadata: { greeting: true },
      });
      await storeAnalyticsEvent({
        sessionId: activeSessionId,
        query: userRawMessage,
        detectedIntent: salesIntent.intent,
        category: salesIntent.category,
        budgetType: salesIntent.budget_type,
        city: salesIntent.city,
      });
      return NextResponse.json({
        result: reply,
        recommendations: [],
        dealers: [],
        reasoning: null,
        aiUsed: true,
        error: undefined,
        followups: [
          "I'm looking for a kitchen sink.",
          "I need a faucet or tap.",
          "Show me food waste disposers.",
          "I'm interested in hobs or chimneys.",
          "Find a dealer near me.",
          "I need installation help.",
        ],
        sessionId: activeSessionId,
      });
    }

    // Step 1: Detect intent (categories + optional clarification)
    const historyIntent = resolveFollowupIntent(userRawMessage, history);
    const intent = historyIntent || (await detectIntent(pipelineMessage));
    const messageHasProductContext = Boolean(
      inferProductContextFromText(userRawMessage) || inferProductContextFromText(pipelineMessage)
    );
    const isOpenPreferenceReply =
      /\b(any|anything|any\s+one|no\s+preference|no\s+preferences|whatever)\b/i.test(userRawMessage) ||
      /\b(any|anything|any\s+one|no\s+preference|no\s+preferences|whatever)\b/i.test(pipelineMessage);
    const resolvedAsContextReply = Boolean(historyIntent) && (!messageHasProductContext || isOpenPreferenceReply);
    const salesIntent = detectSalesIntent(completingDeferred ? pipelineMessage : userRawMessage, intent, history);
    const contactInfo = extractLeadData(userRawMessage, salesIntent, history);
    const interestedProduct = intent.categories?.length ? intent.categories.join(", ") : salesIntent.category;
    if (intent.dealer_intent && (!intent.location || (!intent.location.city && !intent.location.state))) {
      const inferredLocation = inferDealerLocationFromMessage(userRawMessage);
      if (inferredLocation) {
        intent.location = inferredLocation;
        intent.asking_clarification = false;
        intent.clarification_message = null;
      }
    }

    await storeAnalyticsEvent({
      sessionId: activeSessionId,
      query: userRawMessage,
      detectedIntent: salesIntent.intent,
      category: salesIntent.category,
      budgetType: salesIntent.budget_type,
      city: contactInfo.city || salesIntent.city,
    });

    const broadProductFollowups = buildRecommendationFollowups(pipelineMessage, intent);
    if (shouldAskBeforeProductRecommendations(pipelineMessage, intent, resolvedAsContextReply, history)) {
      const planned = await planClarificationWithGPT({
        mode: "pre_catalogue",
        userMessage: userRawMessage,
        historyLines: formatPlannerHistory(history),
        intent: {
          categories: intent.categories,
          asking_clarification: intent.asking_clarification,
          dealer_intent: intent.dealer_intent,
          filters: intent.filters,
        },
        salesIntent: {
          intent: salesIntent.intent,
          category: salesIntent.category ?? undefined,
          budget_type: salesIntent.budget_type,
        },
        backendOpeningHint: getProductClarificationMessage(intent),
        backendSuggestedChips: broadProductFollowups,
        userVolunteeredPhone: hasValidIndianMobileInText(userRawMessage),
      });
      const reply = planned.message;
      await updateLeadRecord({
        sessionId: activeSessionId,
        contactInfo: contactInfoForLeadDatabaseUpdate(contactInfo, leadSnapshotForWrite, allowContactPersist),
        salesIntent,
        interestedProductLabel: interestedProduct ?? null,
        stage: "preferences_collected",
      });
      await storeChatEvent({
        sessionId: activeSessionId,
        role: "assistant",
        message: reply,
        eventType: "assistant_message",
        metadata: {
          followups: planned.followups,
          detectedIntent: salesIntent.intent,
          followupStage: "preferences_collected",
          dialogPlannerGpt: planned.gptUsed,
        },
      });
      return NextResponse.json({
        result: reply,
        recommendations: [],
        dealers: [],
        reasoning: null,
        aiUsed: true,
        error: undefined,
        followups: planned.followups,
        sessionId: activeSessionId,
      });
    }

    // "Show all dealers" / "India" after dealer prompt → return full dealer list.
    const wantsAllDealers =
      /\b(all\s+dealers|show\s+all\s+dealers|list\s+(all\s+)?dealers)\b/i.test(userRawMessage) ||
      /\b(india|pan\s*india|all\s+india|across\s+india|anywhere\s+in\s+india)\b/i.test(userRawMessage);
    if (intent.dealer_intent && wantsAllDealers) {
      const result = "Here are Carysil dealers across India. You can contact them for availability and pricing. Pick a city below to see dealers near you, or contact any from the list.";
      const dealers = allDealers.slice(0, 30);
      const allIndiaFollowup = dealerFollowupQuestion({
        dealerCount: dealers.length,
        cityShort: null,
        locationLabel: "",
        allIndia: true,
      });
      await updateLeadRecord({
        sessionId: activeSessionId,
        contactInfo: contactInfoForLeadDatabaseUpdate(contactInfo, leadSnapshotForWrite, allowContactPersist),
        salesIntent,
        interestedProductLabel: interestedProduct ?? null,
        dealersShown: dealers.length,
        stage: "dealer_offered",
      });
      await storeChatEvent({
        sessionId: activeSessionId,
        role: "assistant",
        message: `${result}\n\n${allIndiaFollowup}`,
        eventType: "assistant_message",
        metadata: {
          dealerCount: dealers.length,
          allIndia: true,
          followupStage: "dealer_offered",
          followups: [allIndiaFollowup],
        },
      });
      await storeChatEvent({
        sessionId: activeSessionId,
        role: "system",
        message: "Dealer results shown",
        eventType: "dealer_results_shown",
        metadata: { dealerCount: dealers.length, allIndia: true },
      });
      await storeAnalyticsEvent({
        sessionId: activeSessionId,
        query: userRawMessage,
        detectedIntent: salesIntent.intent,
        category: salesIntent.category,
        budgetType: salesIntent.budget_type,
        city: contactInfo.city || salesIntent.city,
        eventType: "dealer_request",
        metadata: { dealerCount: dealers.length, allIndia: true },
      });
      await storeChatEvent({
        sessionId: activeSessionId,
        role: "system",
        message: allIndiaFollowup,
        eventType: "followup_question_asked",
        metadata: { context: "dealer_all_india" },
      });
      return NextResponse.json({
        result,
        recommendations: [],
        dealers,
        reasoning: null,
        aiUsed: true,
        error: undefined,
        followups: [allIndiaFollowup],
        followupQuestion: allIndiaFollowup,
        sessionId: activeSessionId,
      });
    }

    if (!intent.dealer_intent && salesIntent.intent === "installation_inquiry") {
      const result = intent.categories.length > 0
        ? `I can help with ${intent.categories.join(", ").toLowerCase()} installation support. What issue are you facing: new installation, fitting guidance, leakage, cleaning, or troubleshooting?`
        : "I can help with installation support. Which Carysil product are you installing, and what issue are you facing?";
      await updateLeadRecord({
        sessionId: activeSessionId,
        contactInfo: contactInfoForLeadDatabaseUpdate(contactInfo, leadSnapshotForWrite, allowContactPersist),
        salesIntent,
        interestedProductLabel: interestedProduct ?? null,
        stage: "preferences_collected",
      });
      await storeChatEvent({
        sessionId: activeSessionId,
        role: "assistant",
        message: result,
        eventType: "assistant_message",
        metadata: { installationSupport: true, detectedIntent: salesIntent.intent },
      });
      await storeAnalyticsEvent({
        sessionId: activeSessionId,
        query: userRawMessage,
        detectedIntent: salesIntent.intent,
        category: salesIntent.category,
        budgetType: salesIntent.budget_type,
        city: contactInfo.city || salesIntent.city,
        eventType: "installation_request",
        metadata: { categories: intent.categories },
      });
      return NextResponse.json({
        result,
        recommendations: [],
        dealers: [],
        reasoning: null,
        aiUsed: true,
        error: undefined,
        followups: [
          "New installation guidance",
          "Troubleshooting or leakage issue",
          "Cleaning and maintenance help",
        ],
        sessionId: activeSessionId,
      });
    }

    if (intent.asking_clarification && intent.clarification_message) {
      const backendChips = buildIntentClarificationFollowups(intent, userRawMessage);
      const planned = await planClarificationWithGPT({
        mode: "intent_clarification",
        userMessage: userRawMessage,
        historyLines: formatPlannerHistory(history),
        intent: {
          categories: intent.categories,
          asking_clarification: intent.asking_clarification,
          dealer_intent: intent.dealer_intent,
          filters: intent.filters,
          clarification_hint: intent.clarification_message,
        },
        salesIntent: {
          intent: salesIntent.intent,
          category: salesIntent.category ?? undefined,
          budget_type: salesIntent.budget_type,
        },
        backendOpeningHint: intent.clarification_message,
        backendSuggestedChips: backendChips,
        userVolunteeredPhone: hasValidIndianMobileInText(userRawMessage),
      });

      await updateLeadRecord({
        sessionId: activeSessionId,
        contactInfo: contactInfoForLeadDatabaseUpdate(contactInfo, leadSnapshotForWrite, allowContactPersist),
        salesIntent,
        interestedProductLabel: interestedProduct ?? null,
        stage: "preferences_collected",
      });
      await storeChatEvent({
        sessionId: activeSessionId,
        role: "assistant",
        message: planned.message,
        eventType: "assistant_message",
        metadata: {
          followups: planned.followups,
          detectedIntent: salesIntent.intent,
          dialogPlannerGpt: planned.gptUsed,
        },
      });
      return NextResponse.json({
        result: planned.message,
        recommendations: [],
        dealers: [],
        reasoning: null,
        aiUsed: true,
        error: undefined,
        followups: planned.followups,
        sessionId: activeSessionId,
      });
    }

    // Step 2: Dealer intent — filter dealers by location and return
    if (intent.dealer_intent && intent.location && (intent.location.city || intent.location.state)) {
      const dealers = filterDealersByLocation(intent.location);
      const locationLabel = formatLocation(intent.location);
      const resultMessage =
        dealers.length > 0
          ? `Here are Carysil dealers in ${locationLabel}. You can call or email them for availability and pricing.`
          : `We don't have a listed dealer in ${locationLabel} yet. Try a nearby city or contact us at carysil.com/reach-us.`;
      const cityShort = intent.location.city?.trim() || null;
      const postDealerFollowup = dealerFollowupQuestion({
        dealerCount: dealers.length,
        cityShort,
        locationLabel,
        allIndia: false,
      });
      const cityForLead = contactInfo.city || intent.location.city || intent.location.state;
      await updateLeadRecord({
        sessionId: activeSessionId,
        contactInfo: contactInfoForLeadDatabaseUpdate(
          { ...contactInfo, city: cityForLead ?? undefined },
          leadSnapshotForWrite,
          allowContactPersist
        ),
        salesIntent,
        interestedProductLabel: interestedProduct ?? null,
        dealersShown: dealers.length,
        stage: "dealer_offered",
      });
      await storeChatEvent({
        sessionId: activeSessionId,
        role: "assistant",
        message: `${resultMessage}\n\n${postDealerFollowup}`,
        eventType: "assistant_message",
        metadata: {
          dealerCount: dealers.length,
          location: intent.location,
          followupStage: "dealer_offered",
          followups: [postDealerFollowup],
        },
      });
      await storeChatEvent({
        sessionId: activeSessionId,
        role: "system",
        message: "Dealer results shown",
        eventType: "dealer_results_shown",
        metadata: { dealerCount: dealers.length, location: intent.location },
      });
      await storeChatEvent({
        sessionId: activeSessionId,
        role: "system",
        message: postDealerFollowup,
        eventType: "followup_question_asked",
        metadata: { context: "dealer_location", location: intent.location },
      });
      await storeAnalyticsEvent({
        sessionId: activeSessionId,
        query: userRawMessage,
        detectedIntent: salesIntent.intent,
        category: salesIntent.category,
        budgetType: salesIntent.budget_type,
        city: cityForLead,
        eventType: "dealer_request",
        metadata: { dealerCount: dealers.length, location: intent.location },
      });
      await storeAnalyticsEvent({
        sessionId: activeSessionId,
        query: userRawMessage,
        detectedIntent: salesIntent.intent,
        category: salesIntent.category,
        budgetType: salesIntent.budget_type,
        city: cityForLead,
        eventType: "followup_question_asked",
        metadata: { context: "dealer_location", question: postDealerFollowup },
      });
      return NextResponse.json({
        result: resultMessage,
        recommendations: [],
        dealers: dealers.slice(0, 10),
        reasoning: null,
        aiUsed: true,
        error: undefined,
        followups: [postDealerFollowup],
        followupQuestion: postDealerFollowup,
        sessionId: activeSessionId,
      });
    }

    leadSnapshotForWrite = await getLeadContactSnapshot(activeSessionId);
    const contactMergedForCatalog = mergeContactForRuntime(
      contactInfo,
      leadSnapshotForWrite,
      allowContactPersist
    );
    const hasCatalogContact = Boolean(contactMergedForCatalog.phone || contactMergedForCatalog.email);
    const isProductRecPath = !intent.dealer_intent && intent.categories.length > 0;

    if (!completingDeferred && isProductRecPath && !hasCatalogContact) {
      await setDeferredProductQuery(activeSessionId, pipelineMessage);
      const intro =
        "Before I share personalised picks from our catalogue, could you share your name and mobile number? Our team can follow up with quotes or dealer options if you need them.";
      await updateLeadRecord({
        sessionId: activeSessionId,
        contactInfo: contactInfoForLeadDatabaseUpdate(contactInfo, leadSnapshotForWrite, allowContactPersist),
        salesIntent,
        interestedProductLabel: interestedProduct ?? null,
        stage: "lead_requested",
        extraScore: 2,
      });
      await storeChatEvent({
        sessionId: activeSessionId,
        role: "assistant",
        message: intro,
        eventType: "assistant_message",
        metadata: { followupStage: "lead_requested", contactBeforeRecommendations: true },
      });
      await storeChatEvent({
        sessionId: activeSessionId,
        role: "system",
        message: "Contact requested before recommendations",
        eventType: "lead_prompted",
        metadata: { context: "contact_before_recommendations" },
      });
      await storeAnalyticsEvent({
        sessionId: activeSessionId,
        query: userRawMessage,
        detectedIntent: salesIntent.intent,
        category: salesIntent.category,
        budgetType: salesIntent.budget_type,
        city: contactInfo.city || salesIntent.city,
        eventType: "lead_prompted",
        metadata: { context: "contact_before_recommendations" },
      });
      return NextResponse.json({
        result: intro,
        recommendations: [],
        dealers: [],
        reasoning: null,
        aiUsed: true,
        error: undefined,
        followups: [],
        assistantMessages: [
          {
            result: intro,
            recommendations: [],
            dealers: [],
            aiUsed: true,
          },
        ],
        sessionId: activeSessionId,
      });
    }

    const contactForEngine: ContactInfo = contactMergedForCatalog;

    // Step 3: semantic + hybrid retrieval for recommendations.
    // We only send top relevant products to AI (never full catalogue).
    const recommendationIntent = enrichProductIntent(pipelineMessage, intent);
    let relevantProducts: Product[] = [];
    const skipVectorEmbedding =
      process.env.SKIP_VECTOR_EMBEDDING === "true" || process.env.SKIP_VECTOR_EMBEDDING === "1";
    try {
      if (skipVectorEmbedding) {
        relevantProducts = [];
      } else {
        const vectorMatches = await searchSimilarProducts(pipelineMessage, {
          limit: 5,
          filters: {
            categories: getSearchCategories(pipelineMessage, recommendationIntent),
            material: recommendationIntent.filters?.material,
            style: recommendationIntent.filters?.style,
            keywords: recommendationIntent.filters?.keywords,
          },
        });
        relevantProducts = vectorMatches.map((row) => ({
          id: row.id,
          name: row.name,
          category: row.category,
          size: row.size ?? undefined,
          style: row.style || "",
          material: row.material || "",
          price_range: "",
          description: row.description || "",
          price: row.price ?? undefined,
          image_url: row.image_url ?? undefined,
          url: row.url ?? undefined,
        }));
        // Recommendation analytics: log every product the retriever returned
        // even if the model later chooses fewer of them. Powers ignored /
        // failed-recommendation views and similarity-at-click metrics.
        if (vectorMatches.length > 0) {
          logRetrieval(
            activeSessionId,
            vectorMatches.map((row) => ({ id: row.id, similarity: row.similarity })),
            pipelineMessage
          );
        }
      }
    } catch (vectorError) {
      console.error("[concierge] vector search failed, using intent filter fallback", vectorError);
      relevantProducts = [];
    }
    if (relevantProducts.length === 0) {
      relevantProducts = filterByIntent(recommendationIntent).slice(0, 8);
    }
    relevantProducts = dedupeProductsById(relevantProducts);

    const placeholderJson = JSON.stringify(
      {
        asking_clarification: false,
        message:
          "Here are some products that might work for you. If you share your budget or style, I can narrow it down further.",
        recommended_ids: [] as string[],
        followup_question: "Would you like me to narrow these down by size, finish, or budget?",
      },
      null,
      2
    );

    const categoryLabel =
      recommendationIntent.categories?.length > 0
        ? recommendationIntent.categories.join(", ")
        : "various";

    // Compact prompt: structured memory + summary + last 8 turns + top 5
    // concise products only. The full catalogue and raw history never reach
    // the model — drops token usage and keeps the LRU cache effective.
    const conciergePrompt = buildConciergePrompt({
      systemPrompt: RECOMMENDATION_SYSTEM,
      memory,
      summary: memory?.conversationSummary ?? null,
      recentMessages: history,
      retrievedProducts: relevantProducts.slice(0, 5).map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        material: p.material,
        size: p.size ?? null,
        price: p.price,
        description: p.description,
      })),
      userMessage: pipelineMessage,
      categoryLabel,
    });

    const { text, aiUsed, error } = await callAI(
      conciergePrompt.systemPrompt,
      conciergePrompt.userContent,
      placeholderJson
    );

    type ConciergeResponse = {
      asking_clarification?: boolean;
      message?: string;
      recommended_ids?: string[];
      followup_question?: string;
    };

    let parsed: ConciergeResponse | null = null;
    const raw = text.replace(/```json?\s*|\s*```/g, "").trim();
    try {
      parsed = JSON.parse(raw) as ConciergeResponse;
    } catch {
      parsed = null;
    }

    const fallbackMessage = aiUsed ? text : "Here are some options that might suit you.";
    let result: ConciergeResponse;
    if (!parsed) {
      result = {
        asking_clarification: false,
        message: fallbackMessage,
        recommended_ids: [],
      };
    } else if (!parsed.message) {
      result = {
        ...parsed,
        message: fallbackMessage,
      };
    } else {
      result = parsed;
    }
    const recommendedIds = Array.isArray(result.recommended_ids)
      ? result.recommended_ids
      : [];
    const allowedProductIds = new Set(relevantProducts.map((product) => product.id));
    const recommendations = recommendedIds
      .map((id) => {
        if (!allowedProductIds.has(id)) return null;
        const p = productById.get(id);
        if (!p) return null;
        return {
          id: p.id,
          name: p.name,
          category: p.category,
          price: p.price,
          image_url: p.image_url,
          url: p.url,
          description: p.description,
        };
      })
      .filter((rec): rec is NonNullable<typeof rec> => rec !== null);
    if (((!aiUsed && relevantProducts.length > 0) || recommendedIds.length > 0) && recommendations.length === 0) {
      recommendations.push(
        ...relevantProducts.slice(0, 4).map((p) => ({
          id: p.id,
          name: p.name,
          category: p.category,
          price: p.price,
          image_url: p.image_url,
          url: p.url,
          description: p.description,
        }))
      );
    }

    const recommendationConfidence: "low" | "medium" | "high" =
      recommendations.length === 0
        ? "low"
        : recommendations.length < 2
          ? "medium"
          : "high";

    const lightRecommendations: RecommendationLite[] = recommendations.map((rec) => ({
      id: rec.id,
      name: rec.name,
      category: rec.category,
      description: rec.description,
    }));

    const engineResult: FollowupResult = generateFollowupQuestion({
      message: pipelineMessage,
      history,
      intent: recommendationIntent,
      salesIntent,
      recommendations: lightRecommendations,
      contactInfo: contactForEngine,
      recommendationConfidence,
    });

    const aiFollowup = sanitizeFollowupQuestion(result.followup_question);
    const wantsLead = engineResult.shouldRequestContact || shouldAskLeadQuestion({
      message: pipelineMessage,
      history,
      intent: recommendationIntent,
      salesIntent,
      recommendations: lightRecommendations,
      contactInfo: contactForEngine,
    });

    const engineLeadQuestion = wantsLead ? engineResult.question : null;
    const primaryCategory = (recommendationIntent.categories?.[0] ?? null) as ProductCategory | null;

    // Resolve the funnel stage early so the planner has access to it.
    const stage: FollowupResult["stage"] = recommendations.length > 0
      ? engineResult.stage === "browsing"
        ? "recommendations_shown"
        : engineResult.stage
      : "preferences_collected";

    // LLM-driven planner runs alongside the rules engine. When the feature
    // flag is on AND the planner picked a high-quality question targeting a
    // missing slot, prefer it. Lead-capture questions still go through the
    // existing engine path so the contact gate semantics stay unchanged.
    let plannerQuestion: string | null = null;
    let followupReason: RecommendationFollowupReason = "none";
    try {
      const planner = await generateNextQuestion({
        sessionId: activeSessionId,
        state: memory,
        summary: memory?.conversationSummary ?? null,
        recentMessages: history,
        recommendationsShown: lightRecommendations,
        leadStage: stage,
        funnelStage: null as FunnelStage | null,
        intent: recommendationIntent,
        salesIntent,
        hasContact: Boolean(contactForEngine.phone || contactForEngine.email),
      });
      if (planner.aiUsed && planner.action === "ask" && planner.question && !wantsLead) {
        plannerQuestion = planner.question;
      }
      followupReason = planner.reason;
    } catch (plannerError) {
      console.error("[concierge] follow-up planner failed", plannerError);
    }

    const followupQuestion =
      engineLeadQuestion ||
      plannerQuestion ||
      aiFollowup ||
      engineResult.question ||
      (recommendations.length > 0
        ? defaultFollowupAfterRecommendations(primaryCategory, lightRecommendations)
        : null);

    let introBody = (result.message || "").trim();
    if (followupQuestion) {
      introBody = stripTrailingFollowup(introBody, followupQuestion);
    }
    introBody = stripCatalogueEchoFromIntro(introBody, recommendations.length > 0);
    const finalMessage = introBody;
    const productLeadIn = "Here are a few options from Carysil:";
    const assistantMessages: Array<{
      result: string;
      recommendations?: typeof recommendations;
      dealers: Dealer[];
      followups?: string[];
      aiUsed: boolean;
      error?: string;
    }> = [
      { result: finalMessage, dealers: [], aiUsed },
      ...(recommendations.length > 0
        ? [{ result: productLeadIn, recommendations, dealers: [] as Dealer[], aiUsed }]
        : []),
      ...(followupQuestion ? [{ result: followupQuestion, dealers: [] as Dealer[], aiUsed }] : []),
    ];

    const scoreDelta = calculateLeadScore({
      salesIntent,
      contactInfo: contactForEngine,
      recommendationsShown: recommendations.length,
    });

    await updateLeadRecord({
      sessionId: activeSessionId,
      contactInfo: contactInfoForLeadDatabaseUpdate(contactInfo, leadSnapshotForWrite, allowContactPersist),
      salesIntent,
      interestedProductLabel: interestedProduct ?? null,
      recommendations: lightRecommendations,
      recommendationsShown: recommendations.length,
      stage,
      extraScore: Math.max(scoreDelta - calculateLeadScore({ salesIntent, contactInfo: contactForEngine }), 0),
      intentConfidence: memoryIntentConfidence,
      buyingConfidence: memoryBuyingConfidence,
    });

    // Behavioral signal capture (Part D). Non-blocking — keeps the per-turn
    // path fast while feeding the decayed scoring view.
    void recordSignalsFromTurn({
      sessionId: activeSessionId,
      salesIntent,
      contactInfo: contactForEngine,
      message: userRawMessage,
      recommendationsShown: recommendations.length,
      refinement: Boolean(historyIntent) && !isOpenPreferenceReply,
    });

    storeChatEventAsync({
      sessionId: activeSessionId,
      role: "assistant",
      message: finalMessage,
      eventType: "assistant_message",
      metadata: {
        chunk: "intro",
        recommendationCount: recommendations.length,
        followupCategory: engineResult.category,
        followupRationale: engineResult.rationale,
        followupStage: stage,
        detectedIntent: salesIntent.intent,
        leadOffered: engineResult.shouldOfferLead,
      },
    });
    if (recommendations.length > 0) {
      storeChatEventAsync({
        sessionId: activeSessionId,
        role: "assistant",
        message: productLeadIn,
        eventType: "assistant_message",
        metadata: {
          chunk: "products",
          recommendationCount: recommendations.length,
          recommendationIds: recommendations.map((rec) => rec.id),
        },
      });
    }
    if (followupQuestion) {
      storeChatEventAsync({
        sessionId: activeSessionId,
        role: "assistant",
        message: followupQuestion,
        eventType: "assistant_message",
        metadata: {
          chunk: "followup",
          followupCategory: engineResult.category,
          followupStage: stage,
        },
      });
    }
    if (recommendations.length > 0) {
      // Structured impression log (one row per product). Used by
      // v_best_converting_products / v_failed_recommendations.
      logShown(
        activeSessionId,
        recommendations.map((rec) => rec.id),
        { query: pipelineMessage.slice(0, 200) }
      );
      storeChatEventAsync({
        sessionId: activeSessionId,
        role: "system",
        message: "Recommendations shown",
        eventType: "recommendations_shown",
        metadata: {
          recommendationIds: recommendations.map((rec) => rec.id),
          interestedProducts: deriveInterestedProducts(lightRecommendations),
        },
      });
      storeAnalyticsEventAsync({
        sessionId: activeSessionId,
        query: userRawMessage,
        detectedIntent: salesIntent.intent,
        category: salesIntent.category,
        budgetType: salesIntent.budget_type,
        city: contactForEngine.city || salesIntent.city,
        eventType: "recommendations_shown",
        metadata: { count: recommendations.length, ids: recommendations.map((rec) => rec.id) },
      });
    }
    if (followupQuestion) {
      const followupEventType: ChatEventType =
        engineResult.shouldRequestContact
          ? "lead_prompted"
          : engineResult.category === "cross_sell"
            ? "cross_sell_offered"
            : "followup_question_asked";
      storeChatEventAsync({
        sessionId: activeSessionId,
        role: "system",
        message: followupQuestion,
        eventType: followupEventType,
        metadata: {
          category: engineResult.category,
          rationale: engineResult.rationale,
          stage,
          followup_reason: followupReason,
          planner_used: plannerQuestion ? true : false,
        },
      });
      storeAnalyticsEventAsync({
        sessionId: activeSessionId,
        query: userRawMessage,
        detectedIntent: salesIntent.intent,
        category: salesIntent.category,
        budgetType: salesIntent.budget_type,
        city: contactForEngine.city || salesIntent.city,
        eventType: engineResult.shouldRequestContact ? "lead_prompted" : "followup_question_asked",
        metadata: {
          followupCategory: engineResult.category,
          followupRationale: engineResult.rationale,
          followupStage: stage,
          question: followupQuestion,
          followup_reason: followupReason,
          planner_used: plannerQuestion ? true : false,
        },
      });
    }

    // Trigger an immediate (best-effort) drain of the event bus so the
    // background batch fires before the serverless host can suspend us. The
    // bus itself has retries, so a partial flush is still safe.
    void flushEventBus().catch(() => {});

    return NextResponse.json({
      result: finalMessage,
      recommendations,
      dealers: [],
      reasoning: null,
      aiUsed,
      error,
      followups: [],
      followupQuestion,
      followupStage: stage,
      followupCategory: engineResult.category,
      assistantMessages,
      sessionId: activeSessionId,
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: "Failed to process message" },
      { status: 500 }
    );
  }
}

function sanitizeFollowupQuestion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  if (trimmed.length > 240) return null;
  // Reject if it asks for personal contact details — engine handles those.
  if (/\b(phone|email|whatsapp|mobile|contact\s+number|your\s+number)\b/i.test(trimmed)) return null;
  // Normalise missing question mark (models often end with a period).
  if (!/[?？]\s*$/.test(trimmed)) {
    const withoutStop = trimmed.replace(/[.!…]+$/g, "").trim();
    if (!withoutStop) return null;
    if (/^(would|do|are|is|can|could|should|shall|may|have\s+you|need\s+you)\b/i.test(withoutStop)) {
      trimmed = `${withoutStop}?`;
    } else {
      return null;
    }
  }
  return trimmed;
}

/**
 * The widget renders product cards (name, price, link); the model often still pastes a full numbered list in JSON "message".
 * Drop catalogue-style content so users are not shown the same products twice.
 */
function stripCatalogueEchoFromIntro(intro: string, hasProductCards: boolean): string {
  if (!hasProductCards || !intro.trim()) return intro;
  const lines = intro.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\d+[\.)]\s+/.test(trimmed)) break;
    const inlineSplit = trimmed.match(/^(.{8,}?)\s+\d+[\.)]\s+.+/);
    if (inlineSplit) {
      kept.push(inlineSplit[1].trimEnd());
      break;
    }
    kept.push(line);
  }
  let t = kept.join("\n").replace(/\*\*([^*]+)\*\*/g, "$1").trim();
  t = t.replace(/\n*\s*(I hope one of these (catches your eye|works for you)|Let me know if any of these (appeal|work))[!.\s]*$/i, "").trim();
  t = t.replace(/[:\u2014\-]\s*$/g, "").trim();
  if (t.length < 16) {
    return "Here are some curated picks from our catalogue that should suit what you're looking for.";
  }
  return t;
}

/** Remove trailing follow-up if the model duplicated it inside `message` (we surface it via `followups`). */
function stripTrailingFollowup(intro: string, followup: string): string {
  const t = followup.trim();
  if (!t || !intro) return intro;
  const lowerIntro = intro.toLowerCase();
  const lowerQ = t.toLowerCase();
  const glued = `\n\n${t}`;
  if (lowerIntro.endsWith(lowerQ)) {
    const idx = lowerIntro.lastIndexOf(lowerQ);
    return intro.slice(0, idx).replace(/\n+\s*$/, "").trim();
  }
  if (lowerIntro.endsWith(glued.toLowerCase())) {
    return intro.slice(0, -glued.length).trim();
  }
  return intro;
}
