import { fetchAllActiveProducts, productMatchesKeyword, type Product } from "@/app/api/ai/concierge/handlers/product";

/**
 * Suggestion chips ("Deck-mount faucets", "Built-in ovens"…) are written by the model and by static lists, so nothing
 * guaranteed that tapping one would return anything. When it didn't, the shopper was offered an option and then told
 * it wasn't available. This drops a chip when we can tell — against the live catalogue — that it has no products.
 *
 * It only drops a chip it positively recognises *and* finds empty. Anything it doesn't understand is kept: an
 * unneeded chip is cheap, a wrongly removed one is not.
 */

type Scope = "Faucet" | "Sink" | "Appliance" | null;

const textOf = (p: Product) =>
  `${p.name} ${p.description ?? ""} ${p.material ?? ""} ${p.facet_text ?? ""}`.toLowerCase().replace(/-/g, " ");

function inScope(p: Product, scope: Scope): boolean {
  if (scope === "Faucet") return p.category === "Faucet";
  if (scope === "Sink") return p.category === "Sink";
  if (scope === "Appliance") return p.category === "Appliance" || p.category === "Hob" || p.category === "Combo";
  return true;
}

/** Which product family a piece of text is talking about; the latest mention wins. */
function scopeFromText(text: string): Scope {
  const lower = text.toLowerCase();
  const mentions: Array<[Scope, number]> = [
    ["Faucet", Math.max(lower.lastIndexOf("faucet"), lower.lastIndexOf(" tap"))],
    ["Sink", lower.lastIndexOf("sink")],
    [
      "Appliance",
      Math.max(
        ...["chimney", "hob", "oven", "coffee", "wine", "microwave", "dishwasher", "refrigerator", "appliance"].map((w) =>
          lower.lastIndexOf(w)
        )
      ),
    ],
  ];
  const best = mentions.filter(([, at]) => at >= 0).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

/** Appliance sub-types: chip wording → words that must appear in a matching product's text. */
const APPLIANCE_SUBTYPES: Array<[RegExp, RegExp]> = [
  [/chimney|hood/i, /chimney|hood/],
  [/\bhobs?\b|cooktop|burner/i, /\bhob|cooktop|burner/],
  [/\bovens?\b/i, /\boven/],
  [/coffee|espresso/i, /coffee|espresso/],
  [/wine/i, /wine/],
  [/microwave/i, /microwave/],
  [/dishwasher/i, /dishwasher/],
  [/refrigerator|fridge/i, /refrigerator|fridge/],
  [/fryer/i, /fryer/],
];

const SINK_TRAITS: Array<[RegExp, RegExp]> = [
  [/single[\s-]?bowl/i, /single bowl|single/],
  [/double[\s-]?bowl|two[\s-]?bowl/i, /double bowl|two bowl|double|2 bowl/],
  [/drainboard|drainer/i, /drainboard|drainer/],
  [/quartz/i, /quartz/],
  [/stainless/i, /stainless/],
];

/** Returns true (keep) / false (drop) / null (not understood). */
function chipHasProducts(chip: string, contextScope: Scope, products: Product[]): boolean | null {
  const faucetKeywords: string[] = [];
  if (/deck[\s-]*mount/i.test(chip)) faucetKeywords.push("deck");
  if (/wall[\s-]*mount/i.test(chip)) faucetKeywords.push("wall");
  if (/pull[\s-]?out|spray/i.test(chip)) faucetKeywords.push("pull-out");
  const finishKeywords: string[] = [];
  if (/chrome/i.test(chip)) finishKeywords.push("chrome");
  if (/black/i.test(chip)) finishKeywords.push("black");
  if (/pvd/i.test(chip)) finishKeywords.push("pvd");
  if (/rose[\s-]?gold/i.test(chip)) finishKeywords.push("rose gold");
  if (/gun[\s-]?metal/i.test(chip)) finishKeywords.push("gun metal");

  const chipMentionsFaucet = /faucet|\btaps?\b/i.test(chip);
  const faucetContext = chipMentionsFaucet || (contextScope === "Faucet" && !/\bsink|chimney|hob|oven/i.test(chip));
  if (faucetContext && (faucetKeywords.length > 0 || finishKeywords.length > 0)) {
    const faucets = products.filter((p) => inScope(p, "Faucet"));
    if (faucets.length === 0) return null;
    // Mounting / pull-out must all hold; finish words are alternatives ("Black or PVD").
    const mountingOk = (p: Product) => faucetKeywords.every((k) => productMatchesKeyword(p, k));
    const finishOk = (p: Product) => finishKeywords.length === 0 || finishKeywords.some((k) => textOf(p).includes(k));
    return faucets.some((p) => mountingOk(p) && finishOk(p));
  }

  const applianceContext = /chimney|\bhobs?\b|oven|coffee|wine|microwave|dishwasher|refrigerator|fridge|fryer/i.test(chip);
  if (applianceContext || (contextScope === "Appliance" && APPLIANCE_SUBTYPES.some(([chipRe]) => chipRe.test(chip)))) {
    const subtype = APPLIANCE_SUBTYPES.find(([chipRe]) => chipRe.test(chip));
    if (!subtype) return null;
    return products.some((p) => inScope(p, "Appliance") && subtype[1].test(textOf(p)));
  }

  const sinkContext = /\bsinks?\b/i.test(chip) || (contextScope === "Sink" && SINK_TRAITS.some(([chipRe]) => chipRe.test(chip)));
  if (sinkContext) {
    const traits = SINK_TRAITS.filter(([chipRe]) => chipRe.test(chip));
    if (traits.length === 0) return null;
    return products.some((p) => inScope(p, "Sink") && traits.every(([, productRe]) => productRe.test(textOf(p))));
  }

  return null;
}

/** `contextText` is the shopper's latest message plus the last few turns; it tells bare chips like "Chrome finish" which family they belong to. */
export async function dropChipsWithNoProducts(chips: string[], contextText: string): Promise<string[]> {
  if (chips.length === 0) return chips;
  let products: Product[];
  try {
    products = await fetchAllActiveProducts();
  } catch {
    return chips;
  }
  if (products.length === 0) return chips;

  const contextScope = scopeFromText(contextText);
  return chips.filter((chip) => typeof chip !== "string" || chipHasProducts(chip, contextScope, products) !== false);
}
