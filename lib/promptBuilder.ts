import type { ConversationState } from "@/types/conversationState";

/**
 * Compact prompt builder for the recommendation/clarification turns.
 *
 * Goals:
 * - Never send the full chat history. Use the structured `ConversationState`
 *   plus a one-sentence summary and the last 6–8 turns.
 * - Never send the full catalogue. Use the top retrieved products in a
 *   tabular "concise" form (id | name | category | material | price | pitch).
 * - Keep the structure stable so the LRU cache in `lib/ai.ts` works well.
 */

export type ConcisePromptMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ConciseProduct = {
  id: string;
  name: string;
  category?: string | null;
  material?: string | null;
  size?: string | null;
  price?: string | null;
  description?: string | null;
};

export type BuiltPrompt = {
  systemPrompt: string;
  userContent: string;
  /** Stable signature used as the cache key for `callAIJsonCached`. */
  cacheKey: string;
};

const TRUNCATE_INTRO = 120;

function trimSentence(text: string, max = TRUNCATE_INTRO): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1).trimEnd()}…`;
}

function formatMemory(memory: ConversationState | null): string {
  if (!memory) return "(no slots yet)";
  const lines: string[] = [];
  const push = (label: string, value: unknown) => {
    if (value === null || value === undefined) return;
    if (typeof value === "string" && value.trim().length === 0) return;
    lines.push(`- ${label}: ${value}`);
  };
  push("user_name", memory.userName);
  push("category", memory.category);
  push("product_type", memory.productType);
  push("budget", memory.budget);
  push("color", memory.color);
  push("material", memory.material);
  push("kitchen_size", memory.kitchenSize);
  push("installation_type", memory.installationType);
  push("city", memory.city);
  push("urgency", memory.urgency);
  if (memory.preferences && Object.keys(memory.preferences).length > 0) {
    push("preferences", JSON.stringify(memory.preferences));
  }
  return lines.length > 0 ? lines.join("\n") : "(no slots yet)";
}

function formatRecentMessages(messages: ConcisePromptMessage[]): string {
  if (messages.length === 0) return "(no prior turns)";
  return messages
    .slice(-8)
    .map((entry) => `${entry.role === "user" ? "User" : "AskCary"}: ${entry.content}`)
    .join("\n");
}

export function toConciseProduct(input: ConciseProduct): {
  id: string;
  name: string;
  category: string;
  material: string;
  size: string;
  price: string;
  pitch: string;
} {
  return {
    id: input.id,
    name: input.name,
    category: input.category ?? "",
    material: input.material ?? "",
    size: input.size ?? "",
    price: input.price ?? "",
    pitch: input.description ? trimSentence(input.description, 120) : "",
  };
}

function formatProducts(products: ConciseProduct[]): string {
  if (products.length === 0) return "(catalogue is empty)";
  return products
    .slice(0, 5)
    .map((product, index) => {
      const c = toConciseProduct(product);
      return `${index + 1}. ${c.id} | ${c.name} | ${c.category} | ${c.material}${c.size ? ` | ${c.size}` : ""}${c.price ? ` | ${c.price}` : ""} | ${c.pitch}`;
    })
    .join("\n");
}

function stableKey(parts: Array<string | number | undefined | null>): string {
  return parts.map((part) => (part == null ? "" : String(part))).join("|");
}

export type BuildConciergePromptInput = {
  systemPrompt: string;
  memory: ConversationState | null;
  summary: string | null;
  recentMessages: ConcisePromptMessage[];
  retrievedProducts: ConciseProduct[];
  /** The current user message AskCary needs to respond to. */
  userMessage: string;
  /** Optional category label for downstream awareness. */
  categoryLabel?: string | null;
  /** True once the user's name has already been acknowledged this session — must not repeat it. */
  nameAcknowledged?: boolean;
  /** This-turn sentiment signal from the conversation analyzer, for tone matching only. */
  sentiment?: "positive" | "neutral" | "negative" | null;
};

export function buildConciergePrompt(input: BuildConciergePromptInput): BuiltPrompt {
  const memoryBlock = formatMemory(input.memory);
  const summaryBlock = input.summary ? input.summary.trim() : "(no summary yet)";
  const recentBlock = formatRecentMessages(input.recentMessages);
  const productsBlock = formatProducts(input.retrievedProducts);
  const nameAcknowledged = Boolean(input.nameAcknowledged);
  const sentiment = input.sentiment ?? "neutral";

  const userContent =
    `Structured memory:\n${memoryBlock}\n\n` +
    `Conversation summary:\n${summaryBlock}\n\n` +
    `Recent conversation:\n${recentBlock}\n\n` +
    `Detected category: ${input.categoryLabel ?? "various"}\n\n` +
    `name_acknowledged: ${nameAcknowledged}\n` +
    `sentiment: ${sentiment}\n\n` +
    `Latest user message:\n${input.userMessage}\n\n` +
    `Relevant catalogue (recommend only from these ids):\n${productsBlock}\n\n` +
    `Respond with strict JSON only.`;

  const cacheKey = stableKey([
    "concierge",
    input.memory?.sessionId,
    input.memory?.updatedAt,
    input.summary?.length,
    input.recentMessages.length,
    input.retrievedProducts.map((product) => product.id).join(","),
    input.userMessage,
    input.categoryLabel,
    String(nameAcknowledged),
    sentiment,
  ]);

  return {
    systemPrompt: input.systemPrompt,
    userContent,
    cacheKey,
  };
}

export type BuildClarificationPromptInput = {
  systemPrompt: string;
  memory: ConversationState | null;
  summary: string | null;
  recentMessages: ConcisePromptMessage[];
  userMessage: string;
  backendHint: string;
  suggestedChips: string[];
  /** True once the user's name has already been acknowledged this session — must not repeat it. */
  nameAcknowledged?: boolean;
  /** This-turn sentiment signal from the conversation analyzer, for tone matching only. */
  sentiment?: "positive" | "neutral" | "negative" | null;
};

export function buildClarificationPrompt(
  input: BuildClarificationPromptInput
): BuiltPrompt {
  const nameAcknowledged = Boolean(input.nameAcknowledged);
  const sentiment = input.sentiment ?? "neutral";
  const userContent =
    `Structured memory:\n${formatMemory(input.memory)}\n\n` +
    `Conversation summary:\n${input.summary?.trim() || "(no summary yet)"}\n\n` +
    `Recent conversation:\n${formatRecentMessages(input.recentMessages)}\n\n` +
    `Suggested backend chips (you may reuse subset, never invent contacts):\n${input.suggestedChips.join("\n") || "(none)"}\n\n` +
    `Backend hint: ${input.backendHint}\n\n` +
    `name_acknowledged: ${nameAcknowledged}\n` +
    `sentiment: ${sentiment}\n\n` +
    `Latest user message:\n${input.userMessage}\n\n` +
    `Respond with strict JSON only.`;

  const cacheKey = stableKey([
    "clarification",
    input.memory?.sessionId,
    input.memory?.updatedAt,
    input.userMessage,
    input.backendHint,
    input.suggestedChips.join(","),
    String(nameAcknowledged),
    sentiment,
  ]);

  return {
    systemPrompt: input.systemPrompt,
    userContent,
    cacheKey,
  };
}
