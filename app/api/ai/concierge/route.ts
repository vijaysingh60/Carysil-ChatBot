import { NextResponse } from "next/server";
import { callAI } from "@/lib/ai";
import { planClarificationWithGPT, planSmallTalkResponse } from "@/lib/conciergeDialogPlanner";
import { detectIntent, CATEGORIES, type ProductCategory } from "@/lib/concierge";
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
  buildContactCaptureFollowupChip,
  STAGE_RANK,
  type FollowupResult,
  type RecommendationLite,
  type ConversationMessage,
} from "@/lib/followupEngine";
import { detectSalesIntent } from "@/lib/intentDetection";
import {
  clearDeferredProductQuery,
  getDeferredProductQuery,
} from "@/services/deferredRecommendationService";
import { hybridSearch } from "@/lib/hybridSearch";
import { enhanceQuery } from "@/lib/queryEnhancement";
import { verifyGroundedResponse } from "@/lib/grounding";
import { storeAnalyticsEvent, storeAnalyticsEventAsync } from "@/services/analyticsService";
import {
  calculateLeadScore,
  contactInfoForLeadDatabaseUpdate,
  getLeadContactSnapshot,
  getLeadFollowupStage,
  mergeContactForRuntime,
} from "@/services/leadService";
import { createSession, storeChatEvent, storeChatEventAsync } from "@/services/sessionService";
import { upsertVisitor } from "@/services/visitorService";
import {
  ingestUserTurn,
  updateConversationState,
  type ConversationTurnSignals,
} from "@/services/conversationStateService";
import { buildConciergePrompt } from "@/lib/promptBuilder";
import { getPrompt } from "@/lib/prompts";
import { flush as flushEventBus } from "@/lib/eventBus";
import { logRetrieval, logShown, logRefinement, logIgnoredProducts } from "@/services/recommendationAnalyticsService";
import { recordSignalsFromTurn } from "@/services/leadScoringService";
import { generateNextQuestion } from "@/lib/followupPlanner";
import type { FunnelStage } from "@/types/funnel";
import type { RecommendationFollowupReason } from "@/types/recommendationEvent";
import type { ChatEventType, ContactInfo } from "@/types/lead";
import type { ConversationState } from "@/types/conversationState";
import {
  type Dealer,
  allDealers,
  filterDealersByLocation,
  formatLocation,
  dealerFollowupQuestion,
  inferDealerLocationFromMessage,
  knownDealerStates,
  normalizeLoc,
  pickBestDealer,
} from "./handlers/dealer";
import {
  type Product,
  dedupeProductsById,
  filterByIntent,
  getSearchCategories,
  enrichProductIntent,
} from "./handlers/product";
import {
  NOT_A_DEALER_CITY_REPLY,
  toTitleCaseLocation,
  inferProductContextFromText,
  resolveFollowupIntent,
  looksLikeDisplayComplaint,
} from "./handlers/intent";
import {
  userProvidedLeadSignals,
  recentlyOfferedDealerConnect,
  isAffirmativeLeadReply,
  hasContactInfo,
  hasValidIndianMobileInText,
  looksLikeDeferredContactCaptureReply,
} from "./handlers/contact";
import {
  sanitizeFollowupQuestion,
  stripCatalogueEchoFromIntro,
  stripTrailingFollowup,
} from "./handlers/response";
import { answerInstallationQuery } from "./handlers/installation";
import { answerArchitectQuery } from "./handlers/architect";

const GREETING_PATTERN = /^(hi|hello|hey|hi there|hello there|good\s+(morning|afternoon|evening)|howdy|greetings?|thanks|thank\s+you|ok|okay)\s*[\.\!]?\s*$/i;

// Off by default for now — scope is product recommendation + dealer routing only.
// The handlers, prompts, and scraped data stay in place; flip these on later.
const installationSupportEnabled =
  process.env.ENABLE_INSTALLATION_SUPPORT === "true" || process.env.ENABLE_INSTALLATION_SUPPORT === "1";
const architectAssistantEnabled =
  process.env.ENABLE_ARCHITECT_ASSISTANT === "true" || process.env.ENABLE_ARCHITECT_ASSISTANT === "1";

function sanitizeHistory(rawHistory: unknown): ConversationMessage[] {
  if (!Array.isArray(rawHistory)) return [];
  return rawHistory
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const role = (entry as { role?: unknown }).role;
      const content = String((entry as { content?: unknown }).content || "").trim();
      if ((role !== "user" && role !== "assistant") || !content) return null;
      return { role, content } as ConversationMessage;
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

/**
 * Scans a small window (not just the single most-recent turn) because a
 * question and a later, separate follow-up bubble (e.g. the soft contact-ask
 * chip) both land as distinct assistant history entries — checking only the
 * last one would miss a budget question asked one bubble earlier.
 */
function recentAssistantMentionedBudget(history: ConversationMessage[]): boolean {
  const blob = history
    .slice(-4)
    .filter((entry) => entry.role === "assistant")
    .map((entry) => entry.content)
    .join("\n");
  return /\bbudget\b|\bprice\b|\bcost\b/i.test(blob);
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
    // Read before any `updateLeadRecord` call could fire this turn (the deferred-lead-capture
    // branch further down writes a new stage but doesn't always return early), so this reflects
    // the *prior* turn's persisted stage — used to gate the soft contact-ask on "recommendations
    // were already shown before" without scanning rendered assistant text.
    const priorFollowupStage = await getLeadFollowupStage(activeSessionId);
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
    let turnSignals: ConversationTurnSignals = {
      greeting: false,
      farewell: false,
      gratitude: false,
      smallTalk: false,
      frustration: false,
      sentiment: null,
      dealerRequest: false,
      installationRequest: false,
      warrantyRequest: false,
      comparisonRequest: false,
      recommendationRequest: false,
      declinesRefinement: false,
      confidence: null,
    };
    try {
      const ingest = await ingestUserTurn(activeSessionId, userRawMessage, history);
      memory = ingest.memory;
      turnSignals = ingest.extraction.turnSignals;
      if (typeof ingest.extraction.intentConfidence === "number") {
        memoryIntentConfidence = ingest.extraction.intentConfidence;
      }
      if (typeof ingest.extraction.buyingConfidence === "number") {
        memoryBuyingConfidence = ingest.extraction.buyingConfidence;
      }
    } catch (memoryError) {
      console.error("[concierge] memory ingest failed", memoryError);
    }

    // Name is durable memory, independent of full lead capture (phone/email) —
    // acknowledged at most once per session by whichever response branch
    // actually speaks to the user this turn.
    const nameAcknowledged = Boolean(
      memory?.preferences && (memory.preferences as Record<string, unknown>).name_acknowledged_at
    );
    const acknowledgeNameIfNeeded = async () => {
      if (!memory?.userName || nameAcknowledged) return;
      try {
        await updateConversationState(activeSessionId, {
          preferences: { name_acknowledged_at: new Date().toISOString() },
        });
      } catch (nameAckError) {
        console.error("[concierge] failed to mark name acknowledged", nameAckError);
      }
    };

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

    // Pure small talk (greeting/farewell/gratitude/chit-chat with no product or
    // dealer request) → warm LLM-generated reply, no catalogue search. The
    // analyzer already commits to `smallTalk: false` whenever a message mixes
    // a greeting with a real request (e.g. "hello, looking for a sink"); the
    // cheap regex/keyword checks below are a belt-and-suspenders guard against
    // routing an actionable message down this fast path.
    const hasNoActionableIntent =
      !turnSignals.dealerRequest &&
      !turnSignals.installationRequest &&
      !turnSignals.warrantyRequest &&
      !turnSignals.comparisonRequest &&
      !turnSignals.recommendationRequest;
    const isPureSmallTalk =
      (turnSignals.smallTalk ||
        turnSignals.greeting ||
        turnSignals.farewell ||
        turnSignals.gratitude ||
        GREETING_PATTERN.test(userRawMessage)) &&
      hasNoActionableIntent &&
      !inferProductContextFromText(userRawMessage);

    if (isPureSmallTalk) {
      const planned = await planSmallTalkResponse({
        userMessage: userRawMessage,
        historyLines: formatPlannerHistory(history),
        greeting: turnSignals.greeting || GREETING_PATTERN.test(userRawMessage),
        farewell: turnSignals.farewell,
        gratitude: turnSignals.gratitude,
        smallTalk: turnSignals.smallTalk,
        userName: memory?.userName ?? null,
        nameAcknowledged,
        sentiment: turnSignals.sentiment,
      });
      void acknowledgeNameIfNeeded();
      const salesIntent = detectSalesIntent(userRawMessage, undefined, history);
      await storeChatEvent({
        sessionId: activeSessionId,
        role: "assistant",
        message: planned.message,
        eventType: "assistant_message",
        metadata: { smallTalk: true, dialogPlannerGpt: planned.gptUsed },
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

    // Step 1: Detect intent (categories + optional clarification)
    const historyIntent = resolveFollowupIntent(userRawMessage, history);
    const intent = historyIntent || (await detectIntent(pipelineMessage));
    // "I can't see the products" — resolveFollowupIntent already recovers the last
    // product category so this re-runs retrieval instead of re-clarifying; this flag
    // just lets the eventual response acknowledge the complaint when it succeeds.
    const isDisplayComplaint = looksLikeDisplayComplaint(userRawMessage);
    const messageHasProductContext = Boolean(
      inferProductContextFromText(userRawMessage) || inferProductContextFromText(pipelineMessage)
    );
    const isOpenPreferenceReply =
      /\b(any|anything|any\s+one|no\s+preference|no\s+preferences|whatever)\b/i.test(userRawMessage) ||
      /\b(any|anything|any\s+one|no\s+preference|no\s+preferences|whatever)\b/i.test(pipelineMessage);
    const resolvedAsContextReply = Boolean(historyIntent) && (!messageHasProductContext || isOpenPreferenceReply);
    const salesIntent = detectSalesIntent(completingDeferred ? pipelineMessage : userRawMessage, intent, history);
    const contactInfo = extractLeadData(userRawMessage, salesIntent, history);
    // The regex-based name extractor in leadService doesn't cover every phrasing
    // (e.g. "myself Vijay"). Prefer the analyzer's memory.userName when the
    // regex chain found nothing this turn — same PII-persist gating still
    // applies downstream via contactInfoForLeadDatabaseUpdate/allowContactPersist.
    if (!contactInfo.name && memory?.userName) {
      contactInfo.name = memory.userName;
    }
    const interestedProduct = intent.categories?.length ? intent.categories.join(", ") : salesIntent.category;
    if (intent.dealer_intent && (!intent.location || (!intent.location.city && !intent.location.state))) {
      const inferredLocation = inferDealerLocationFromMessage(userRawMessage, NOT_A_DEALER_CITY_REPLY);
      if (inferredLocation) {
        intent.location = inferredLocation;
        intent.asking_clarification = false;
        intent.clarification_message = null;
      }
    }

    // Clarification loop guard: `detectIntent`/`shouldAskBeforeProductRecommendations`
    // are pure per-message checks with no memory of prior turns, so a vague-but-declining
    // reply ("no preference", "just sinks") gets re-asked the same question forever.
    // Reuse the analyzer's `declinesRefinement` signal plus a small per-category attempt
    // counter (persisted in the existing `preferences` JSONB — no new column) to force at
    // most one clarification attempt per category, then always fall through to recommendations.
    //
    // A decline reply that drops the product word entirely (e.g. "anything is fine" after
    // "I want a faucet") loses `intent.categories` too, since detectIntent/resolveFollowupIntent
    // only look at the current message. Recover the category from the durable `memory.category`
    // slot (populated by the same analyzer, preserved across turns via COALESCE) in that case.
    //
    // Same context-loss shape shows up for a genuine (non-declining) answer that's just a bare
    // number replying to a budget question ("5000") — recover the category the same way, gated
    // on the assistant having recently asked about budget/price/cost so an unprompted phone
    // number or pincode doesn't get misread as a budget answer.
    const isBareNumericBudgetReply =
      /^\s*(?:rs\.?|₹)?\s*[\d,]+\s*$/i.test(userRawMessage) && recentAssistantMentionedBudget(history);
    if (
      !intent.dealer_intent &&
      intent.categories.length === 0 &&
      (turnSignals.declinesRefinement || isBareNumericBudgetReply) &&
      memory?.category &&
      (CATEGORIES as readonly string[]).includes(memory.category)
    ) {
      intent.categories = [memory.category as ProductCategory];
    }
    const clarificationMemo =
      (memory?.preferences as { clarification?: { category?: string; attempts?: number } } | undefined)
        ?.clarification ?? null;
    const clarificationCategory = intent.categories?.[0] ?? null;
    const clarificationAttemptsExhausted = Boolean(
      clarificationCategory &&
        clarificationMemo?.category === clarificationCategory &&
        (clarificationMemo.attempts ?? 0) >= 1
    );
    const suppressClarification =
      !intent.dealer_intent &&
      intent.categories.length === 1 &&
      (turnSignals.declinesRefinement || clarificationAttemptsExhausted || isBareNumericBudgetReply);
    if (suppressClarification) {
      intent.asking_clarification = false;
      intent.clarification_message = null;
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
    if (!suppressClarification && shouldAskBeforeProductRecommendations(pipelineMessage, intent, resolvedAsContextReply, history)) {
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
        userName: memory?.userName ?? null,
        nameAcknowledged,
        sentiment: turnSignals.sentiment,
      });
      const reply = planned.message;
      void acknowledgeNameIfNeeded();
      if (clarificationCategory) {
        void updateConversationState(activeSessionId, {
          preferences: {
            clarification: {
              category: clarificationCategory,
              attempts: (clarificationMemo?.attempts ?? 0) + 1,
            },
          },
        });
      }
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

    // Feature-flagged off for now (product recommendation + dealer routing only) —
    // set ENABLE_INSTALLATION_SUPPORT=true to re-enable. Handler/prompt/data stay
    // in place; disabled here just skips the branch so these intents fall through
    // to the normal recommendation flow like any other message.
    if (
      installationSupportEnabled &&
      !intent.dealer_intent &&
      salesIntent.intent === "installation_inquiry"
    ) {
      const installationCategory = intent.categories.length > 0 ? intent.categories.join(", ") : null;
      // Grounded in real carysil.com FAQ content (see lib/documentSearch.ts +
      // handlers/installation.ts) instead of a canned clarifying question —
      // answers directly when we have a confirmed source, otherwise escalates
      // to a dealer/support contact rather than guessing at installation steps.
      const installationAnswer = await answerInstallationQuery(userRawMessage, installationCategory);
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
        message: installationAnswer.message,
        eventType: "assistant_message",
        metadata: {
          installationSupport: true,
          detectedIntent: salesIntent.intent,
          matched: installationAnswer.matched,
          sources: installationAnswer.sources,
        },
      });
      await storeAnalyticsEvent({
        sessionId: activeSessionId,
        query: userRawMessage,
        detectedIntent: salesIntent.intent,
        category: salesIntent.category,
        budgetType: salesIntent.budget_type,
        city: contactInfo.city || salesIntent.city,
        // Distinct from the generic "installation_request" intent-tracking event above —
        // this tells the dashboard whether the FAQ knowledge base actually covered the
        // question, which is the signal for deciding whether to invest in sourcing real
        // internal manuals (see plans/for-ask-cary-spicy-planet.md Phase 1).
        eventType: installationAnswer.matched ? "installation_answered" : "installation_escalated",
        metadata: { categories: intent.categories, sources: installationAnswer.sources },
      });
      return NextResponse.json({
        result: installationAnswer.message,
        recommendations: [],
        dealers: [],
        reasoning: null,
        aiUsed: true,
        error: undefined,
        followups: installationAnswer.followups,
        sessionId: activeSessionId,
      });
    }

    // Architect/designer/contractor persona (see resolvePersona in
    // services/conversationStateService.ts — sticky once detected, folded into
    // memory.preferences.persona rather than a new column). Only takes over when
    // there's also a concrete product category this turn; pure chit-chat from a
    // professional still goes through the normal small-talk path below.
    // Feature-flagged off for now — set ENABLE_ARCHITECT_ASSISTANT=true to
    // re-enable; handler/prompt stay in place, this just skips the branch.
    const userPersona = (memory?.preferences as { persona?: string } | undefined)?.persona;
    if (
      architectAssistantEnabled &&
      userPersona === "professional" &&
      !intent.dealer_intent &&
      !turnSignals.smallTalk &&
      intent.categories.length > 0
    ) {
      const architectAnswer = await answerArchitectQuery(userRawMessage, intent.categories);
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
        message: architectAnswer.message,
        eventType: "assistant_message",
        metadata: { architectAssistant: true, sources: architectAnswer.sources },
      });
      await storeAnalyticsEvent({
        sessionId: activeSessionId,
        query: userRawMessage,
        detectedIntent: salesIntent.intent,
        category: salesIntent.category,
        budgetType: salesIntent.budget_type,
        city: contactInfo.city || salesIntent.city,
        eventType: "architect_query_answered",
        metadata: { categories: intent.categories, sources: architectAnswer.sources },
      });
      return NextResponse.json({
        result: architectAnswer.message,
        recommendations: [],
        dealers: [],
        reasoning: null,
        aiUsed: true,
        error: undefined,
        followups: architectAnswer.followups,
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
        userName: memory?.userName ?? null,
        nameAcknowledged,
        sentiment: turnSignals.sentiment,
      });
      void acknowledgeNameIfNeeded();
      if (clarificationCategory) {
        void updateConversationState(activeSessionId, {
          preferences: {
            clarification: {
              category: clarificationCategory,
              attempts: (clarificationMemo?.attempts ?? 0) + 1,
            },
          },
        });
      }

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
      const bestDealer = pickBestDealer(dealers, intent.categories?.[0] ?? salesIntent.category ?? null);
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
        assignedDealerId: bestDealer?.id ?? null,
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
      if (bestDealer) {
        await storeChatEvent({
          sessionId: activeSessionId,
          role: "system",
          message: "Lead routed to dealer",
          eventType: "dealer_assigned",
          metadata: {
            dealerId: bestDealer.id,
            dealerName: bestDealer.name,
            city: bestDealer.city,
            state: bestDealer.state,
          },
        });
      }
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
        assignedDealer: bestDealer ? { id: bestDealer.id, name: bestDealer.name } : null,
        reasoning: null,
        aiUsed: true,
        error: undefined,
        followups: [postDealerFollowup],
        followupQuestion: postDealerFollowup,
        sessionId: activeSessionId,
      });
    }

    // Recommendations are never gated on contact info — the assistant helps
    // first and only offers to capture a phone/email afterwards (see the
    // follow-up decision below, which reuses shouldAskLeadQuestion /
    // buildContactCaptureFollowupChip). `hasFullContact` is still tracked for
    // scoring and for the follow-up engine's own contact-aware branches.
    leadSnapshotForWrite = await getLeadContactSnapshot(activeSessionId);
    const contactMergedForCatalog = mergeContactForRuntime(
      contactInfo,
      leadSnapshotForWrite,
      allowContactPersist
    );
    const hasFullContact = Boolean(contactMergedForCatalog.phone || contactMergedForCatalog.email);
    const contactForEngine: ContactInfo = contactMergedForCatalog;

    // Step 3: hybrid retrieval (vector + FTS) for recommendations.
    // Query is enhanced with conversation state context before retrieval.
    const recommendationIntent = enrichProductIntent(pipelineMessage, intent);
    const enhancedQuery = enhanceQuery(pipelineMessage, memory);
    let relevantProducts: Product[] = [];
    let retrievedMatches: import("@/lib/vectorSearch").SimilarProduct[] = [];
    const skipVectorEmbedding =
      process.env.SKIP_VECTOR_EMBEDDING === "true" || process.env.SKIP_VECTOR_EMBEDDING === "1";
    try {
      if (skipVectorEmbedding) {
        relevantProducts = [];
      } else {
        const hybridMatches = await hybridSearch(enhancedQuery, {
          limit: 5,
          categories: getSearchCategories(pipelineMessage, recommendationIntent),
          material: recommendationIntent.filters?.material,
          style: recommendationIntent.filters?.style,
          keywords: recommendationIntent.filters?.keywords,
        });
        retrievedMatches = hybridMatches;
        relevantProducts = hybridMatches.map((row) => ({
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
        if (hybridMatches.length > 0) {
          logRetrieval(
            activeSessionId,
            hybridMatches.map((row) => ({ id: row.id, similarity: row.similarity })),
            pipelineMessage
          );
        }
      }
    } catch (vectorError) {
      console.error("[concierge] hybrid search failed, using intent filter fallback", vectorError);
      relevantProducts = [];
    }
    if (relevantProducts.length === 0) {
      relevantProducts = (await filterByIntent(recommendationIntent)).slice(0, 8);
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
      systemPrompt: getPrompt("product_recommendation"),
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
      nameAcknowledged,
      sentiment: turnSignals.sentiment,
    });
    void acknowledgeNameIfNeeded();

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

    // Grounding check: verify the AI message doesn't mention prices not in retrieved products.
    if (result.message && retrievedMatches.length > 0) {
      const grounding = verifyGroundedResponse(result.message, { products: retrievedMatches });
      if (!grounding.valid) {
        console.warn("[concierge] grounding issues:", grounding.issues);
        result = { ...result, message: grounding.safeResponse };
      }
    }

    const recommendedIds = Array.isArray(result.recommended_ids)
      ? result.recommended_ids
      : [];
    // Recommended ids must come from the products we actually retrieved this
    // turn (hybrid search / intent filter), looked up from that same set —
    // not a separate global catalogue — so DB-sourced ids always resolve.
    const relevantProductById = new Map(relevantProducts.map((product) => [product.id, product]));
    const recommendations = recommendedIds
      .map((id) => {
        const p = relevantProductById.get(id);
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

    // Guard against the bug where the model returns `recommended_ids: []` (a
    // correct "no good match" signal per the product_recommendation prompt)
    // while still writing confident/upbeat text — the "always warm
    // acknowledgment" and "say so if no matches" prompt rules are independent,
    // so nothing upstream cross-checks them, and the UI renders zero cards
    // under a message that implies success. Every turn in this recommendation
    // path is generated by the same prompt, so forcing an honest "no match"
    // framing here whenever recommendations end up empty is always correct.
    if (recommendations.length === 0) {
      const fallbackCategoryPhrase = categoryLabel === "various" ? "catalogue" : categoryLabel.toLowerCase();
      result = {
        ...result,
        message: `I couldn't find an exact match for that in our ${fallbackCategoryPhrase} range — want me to show close alternatives, or adjust the budget/material?`,
      };
    } else if (isDisplayComplaint) {
      // Retrieval succeeded on retry — acknowledge the earlier display issue
      // rather than silently re-showing products as if nothing happened.
      result = {
        ...result,
        message: `Sorry about that — here they are again:\n\n${result.message ?? ""}`.trim(),
      };
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
      // Same decline/exhaustion signals that gate the pre-catalogue clarification guard
      // above (line ~537) — without this, the post-recommendation engine would re-open
      // the same "keep asking for filters" loop that guard was built to close.
      declinesRefinement: turnSignals.declinesRefinement || clarificationAttemptsExhausted,
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

    // Resolve the funnel stage early so the planner (and the follow-up
    // arbitration below) has access to it. `generateFollowupQuestion`'s stage
    // describes what KIND of question it chose (several branches return
    // "preferences_collected"/"cross_sell_offered" even when recommendations
    // were just shown), so it can rank below "recommendations_shown" despite
    // recs being shown this turn. Take the higher of the two via STAGE_RANK —
    // the persisted stage must never regress below what factually happened —
    // mirroring the same monotonic-progression pattern `maxStage` already
    // uses inside `lib/followupEngine.ts`.
    const stage: FollowupResult["stage"] = recommendations.length > 0
      ? STAGE_RANK[engineResult.stage] >= STAGE_RANK.recommendations_shown
        ? engineResult.stage
        : "recommendations_shown"
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
        hasContact: hasFullContact,
      });
      if (planner.aiUsed && planner.action === "ask" && planner.question && !wantsLead) {
        plannerQuestion = planner.question;
      }
      followupReason = planner.reason;
    } catch (plannerError) {
      console.error("[concierge] follow-up planner failed", plannerError);
    }

    // Single arbitration point: exactly one of these candidates survives, in priority
    // order (explicit lead-request > planner slot-fill > AI's own follow-up > a
    // *meaningful* product/dealer question from the rules engine > soft contact-ask >
    // the rules engine's own generic tail-end question > generic fallback).
    // The soft contact-ask used to be a second, independent bolt-on appended alongside
    // whatever this chain already chose — folding it in here as one more candidate is
    // what makes "exactly one question per turn" hold. It's gated on `priorStageHadRecommendations`
    // (read from the already-persisted `leads.followup_stage` column, not by scanning
    // rendered assistant text) so it never fires on the very first recommendation turn.
    //
    // `generateFollowupQuestion` (lib/followupEngine.ts) always returns SOME question once
    // recommendations exist — its own last two branches ("generic_cross_sell"/"default_followup")
    // are a generic tail-end fallback, not a targeted missing-slot question. Without excluding
    // those two specifically, `engineResult.question` would virtually always be truthy and the
    // soft ask (ranked below it) would never get a turn to win — so only *specific* engine
    // questions (bowl/finish/city/hob-type/etc.) outrank the soft ask; its own generic fallback
    // ranks below the soft ask, same as route.ts's separate `defaultFollowupAfterRecommendations`.
    const GENERIC_ENGINE_RATIONALES = new Set(["generic_cross_sell", "default_followup"]);
    const meaningfulEngineQuestion =
      engineResult.question && !GENERIC_ENGINE_RATIONALES.has(engineResult.rationale)
        ? engineResult.question
        : null;
    const priorStageHadRecommendations =
      STAGE_RANK[priorFollowupStage ?? "browsing"] >= STAGE_RANK.recommendations_shown;
    const contactCaptureCandidate =
      recommendations.length > 0 && !hasFullContact && priorStageHadRecommendations
        ? buildContactCaptureFollowupChip(null, contactForEngine, history)
        : null;
    const followupQuestion =
      engineLeadQuestion ||
      plannerQuestion ||
      aiFollowup ||
      meaningfulEngineQuestion ||
      contactCaptureCandidate ||
      engineResult.question ||
      (recommendations.length > 0
        ? defaultFollowupAfterRecommendations(primaryCategory, lightRecommendations)
        : null);
    const softContactAskWon = Boolean(contactCaptureCandidate) && followupQuestion === contactCaptureCandidate;

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
    const isRefinementTurn = Boolean(historyIntent) && !isOpenPreferenceReply;
    void recordSignalsFromTurn({
      sessionId: activeSessionId,
      salesIntent,
      contactInfo: contactForEngine,
      message: userRawMessage,
      recommendationsShown: recommendations.length,
      refinement: isRefinementTurn,
    });
    if (isRefinementTurn && retrievedMatches.length > 0) {
      const previousUserMessage =
        history.filter((m) => m.role === "user").slice(-1)[0]?.content ?? null;
      logRefinement(
        activeSessionId,
        retrievedMatches.map((m) => m.id),
        pipelineMessage,
        previousUserMessage
      );
    }

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
        engineResult.shouldRequestContact || softContactAskWon
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
          soft_contact_ask: softContactAskWon,
        },
      });
      storeAnalyticsEventAsync({
        sessionId: activeSessionId,
        query: userRawMessage,
        detectedIntent: salesIntent.intent,
        category: salesIntent.category,
        budgetType: salesIntent.budget_type,
        city: contactForEngine.city || salesIntent.city,
        eventType: engineResult.shouldRequestContact || softContactAskWon ? "lead_prompted" : "followup_question_asked",
        metadata: {
          followupCategory: engineResult.category,
          followupRationale: engineResult.rationale,
          followupStage: stage,
          question: followupQuestion,
          followup_reason: followupReason,
          planner_used: plannerQuestion ? true : false,
          soft_contact_ask: softContactAskWon,
        },
      });
    }

    // Trigger an immediate (best-effort) drain of the event bus so the
    // background batch fires before the serverless host can suspend us. The
    // bus itself has retries, so a partial flush is still safe.
    const eventBusFlush = flushEventBus();
    void eventBusFlush.catch(() => {});
    if (retrievedMatches.length > 0) {
      // logIgnoredProducts reads rows this same turn's retrieved/shown logs
      // just wrote — must wait for the batched event-bus flush above first,
      // or it'll find nothing and silently no-op.
      void eventBusFlush.then(() => logIgnoredProducts(activeSessionId)).catch(() => {});
    }

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
