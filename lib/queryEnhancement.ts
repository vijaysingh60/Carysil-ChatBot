import type { ConversationState } from "@/types/conversationState";

export function enhanceQuery(query: string, state: ConversationState | null): string {
  if (!state) return query;

  const contextParts: string[] = [];
  if (state.category) contextParts.push(state.category);
  if (state.material) contextParts.push(state.material);
  if (state.color) contextParts.push(state.color);
  if (state.budget) contextParts.push(`budget ${state.budget}`);

  if (contextParts.length === 0) return query;
  return `${query} ${contextParts.join(" ")}`;
}
