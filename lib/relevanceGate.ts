/**
 * Deterministic guard against the model padding a recommendation list with loosely related products.
 *
 * The prompt asks for only the exact type requested, but the model still sometimes tops a 1–2 item answer up to 4
 * cards — ovens for an "air fryer", ordinary chimneys for an "island chimney". When the shopper used a specific word
 * ("barbecue", "island", "warming drawer") and some of the picks contain it while others don't, the others are noise.
 *
 * Deliberately narrow: appliances and accessories only. For sinks and faucets the qualifiers are attributes (colour,
 * bowl count, finish) that live in fields this check does not see, so pruning there could drop good answers.
 */

const GATED_CATEGORIES = new Set(["Appliance", "Hob", "Combo", "Accessory"]);

const STOP_WORDS = new Set(
  (
    "a an the and or for with without in on of to my me i we you your is are any some all just show give list need want " +
    "looking look please best good nice more option options preference preferences no not sure kitchen bathroom home " +
    "house new range product products carysil buy price budget under below above over cheap size finish colour color " +
    "available which what have has do does can could would like one two built unit model type kind ok okay yes yeah " +
    "them it this that there here get find see tell about also too very much many few cm mm kg " +
    "sink sinks faucet faucets tap taps hob hobs chimney chimneys appliance appliances accessory accessories " +
    "cooktop cooktops"
  ).split(" ")
);

/** "Barbecue"/"barbeque", "apron"/"appron", … — the catalogue's own spellings count as the same word. */
const EQUIVALENT_FORMS: Array<[RegExp, string[]]> = [
  [/^barbe(?:cue|que)s?$|^bbq$/, ["barbecue", "barbeque", "bbq"]],
  [/^apr[o]?ns?$/, ["apron", "appron"]],
  [/^fridges?$/, ["fridge", "refrigerator"]],
  [/^hoods?$/, ["hood", "chimney"]],
];

function stem(word: string): string {
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

export function distinctiveTerms(requestText: string): string[][] {
  const words = requestText
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !/\d/.test(w) && !STOP_WORDS.has(w));
  const groups: string[][] = [];
  for (const word of Array.from(new Set(words))) {
    const forms = EQUIVALENT_FORMS.find(([pattern]) => pattern.test(word))?.[1] ?? [stem(word)];
    groups.push(forms);
  }
  return groups;
}

type Gateable = { id: string; category?: string | null };

/**
 * Keeps only the recommendations whose text contains at least one of the request's distinctive words — but only when
 * that actually separates them (some match, some don't). Otherwise returns the list unchanged.
 */
export function gateByRequestedTerms<T extends Gateable>(
  recommendations: T[],
  textById: Map<string, string>,
  requestText: string
): T[] {
  if (recommendations.length < 2) return recommendations;
  if (!recommendations.every((r) => r.category && GATED_CATEGORIES.has(r.category))) return recommendations;

  const terms = distinctiveTerms(requestText);
  if (terms.length === 0) return recommendations;

  const matches = recommendations.filter((r) => {
    const text = (textById.get(r.id) ?? "").toLowerCase().replace(/-/g, " ");
    return terms.some((forms) => forms.some((form) => text.includes(form)));
  });
  return matches.length > 0 && matches.length < recommendations.length ? matches : recommendations;
}
