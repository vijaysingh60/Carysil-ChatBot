export type RecommendationEventType =
  | "retrieved"
  | "shown"
  | "clicked"
  | "ignored"
  | "refined"
  | "converted";

export type RecommendationEventInput = {
  sessionId: string;
  productId: string;
  eventType: RecommendationEventType;
  retrievalRank?: number | null;
  similarity?: number | null;
  metadata?: Record<string, unknown>;
};

export type RecommendationFollowupReason =
  | "missing_budget"
  | "missing_color"
  | "missing_material"
  | "missing_kitchen_size"
  | "missing_installation_type"
  | "missing_city"
  | "missing_urgency"
  | "qualification"
  | "dealer_conversion"
  | "quotation_handoff"
  | "none";
