export type ConversationStateSlot =
  | "category"
  | "product_type"
  | "budget"
  | "color"
  | "material"
  | "kitchen_size"
  | "installation_type"
  | "city"
  | "urgency";

export type ConversationState = {
  sessionId: string;
  userName: string | null;
  category: string | null;
  productType: string | null;
  budget: string | null;
  color: string | null;
  material: string | null;
  kitchenSize: string | null;
  installationType: string | null;
  city: string | null;
  urgency: string | null;
  buyingStage: string | null;
  preferences: Record<string, unknown>;
  extractedEntities: Record<string, unknown>;
  conversationSummary: string | null;
  summaryTokenEstimate: number;
  lastSummarizedAt: string | null;
  updatedAt: string;
};

export type ConversationStatePatch = Partial<
  Omit<ConversationState, "sessionId" | "updatedAt">
>;

export const CONVERSATION_SLOTS: ConversationStateSlot[] = [
  "category",
  "product_type",
  "budget",
  "color",
  "material",
  "kitchen_size",
  "installation_type",
  "city",
  "urgency",
];

/** Slots that the follow-up planner can ask about; ordered roughly by sales value. */
export const PLANNER_SLOT_PRIORITY: ConversationStateSlot[] = [
  "category",
  "product_type",
  "budget",
  "kitchen_size",
  "material",
  "color",
  "installation_type",
  "city",
  "urgency",
];
