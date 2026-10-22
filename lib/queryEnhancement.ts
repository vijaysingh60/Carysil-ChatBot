import type { ConversationState } from "@/types/conversationState";

/**
 * Spelling variants and everyday synonyms the catalogue does not share with shoppers, so keyword search can still hit
 * the product ("barbecue" vs the catalogue's "Barbeque", "apron" vs "Appron Sink", "tap" vs "faucet"). Appended, never
 * replacing, so the shopper's own words still count.
 */
const QUERY_SYNONYMS: Array<[RegExp, string]> = [
  [/\b(?:barbecue|barbeque|bbq|barbecues)\b/i, "barbeque barbecue bbq"],
  [/\bapr[o]?n\b/i, "apron appron"],
  [/\b(?:taps?)\b/i, "faucet"],
  [/\b(?:hood|hoods)\b/i, "chimney"],
  [/\b(?:fridge|fridges)\b/i, "refrigerator"],
  [/\b(?:cooktops?|stovetops?)\b/i, "hob"],
  [/\bair\s*fry(?:er|ers)?\b/i, "air fryer"],
  [/\bmicrowaves?\b/i, "microwave oven"],
];

export function expandQuerySynonyms(query: string): string {
  const extras = QUERY_SYNONYMS.filter(([pattern]) => pattern.test(query)).map(([, extra]) => extra);
  return extras.length > 0 ? `${query} ${extras.join(" ")}` : query;
}

export function enhanceQuery(rawQuery: string, state: ConversationState | null): string {
  const query = expandQuerySynonyms(rawQuery);
  if (!state) return query;

  const contextParts: string[] = [];
  if (state.category) contextParts.push(state.category);
  if (state.material) contextParts.push(state.material);
  if (state.color) contextParts.push(state.color);
  if (state.budget) contextParts.push(`budget ${state.budget}`);

  if (contextParts.length === 0) return query;
  return `${query} ${contextParts.join(" ")}`;
}
