export type ChatRole = "user" | "assistant" | "system";

export type ChatEventType =
  | "user_message"
  | "assistant_message"
  | "recommendations_shown"
  | "recommendations_deferred"
  | "dealer_results_shown"
  | "lead_prompted"
  | "lead_captured"
  | "followup_question_asked"
  | "followup_question_answered"
  | "cross_sell_offered"
  | "dealer_request"
  | "quotation_request"
  | "installation_request";

export type SalesIntentName =
  | "browsing"
  | "budget_purchase"
  | "dealer_inquiry"
  | "installation_inquiry"
  | "premium_purchase"
  | "quotation_request"
  | "contact_request";

export type BudgetType = "budget" | "mid" | "high" | "unknown";

export type UrgencyType = "low" | "medium" | "high";

export type FollowupStage =
  | "browsing"
  | "preferences_collected"
  | "recommendations_shown"
  | "cross_sell_offered"
  | "dealer_offered"
  | "lead_requested"
  | "lead_captured";

export type FollowupCategory =
  | "clarification"
  | "cross_sell"
  | "dealer"
  | "lead"
  | "none";

export type InterestedProduct = {
  id?: string;
  name?: string;
  category?: string;
  shown_at?: string;
};

export type DetectedSalesIntent = {
  intent: SalesIntentName;
  category: string | null;
  budget_type: BudgetType;
  city: string | null;
  urgency: UrgencyType;
  lead_probability: number;
  signals: string[];
};

export type ContactInfo = {
  name?: string;
  phone?: string;
  email?: string;
  city?: string;
};

export type LeadUpdate = ContactInfo & {
  intent?: string | null;
  interestedProduct?: string | null;
  interestedProducts?: InterestedProduct[];
  followupStage?: FollowupStage;
  scoreDelta: number;
};

export type AnalyticsEventInput = {
  sessionId: string;
  query: string;
  detectedIntent?: string | null;
  category?: string | null;
  budgetType?: string | null;
  city?: string | null;
  eventType?: string | null;
  metadata?: Record<string, unknown>;
};
