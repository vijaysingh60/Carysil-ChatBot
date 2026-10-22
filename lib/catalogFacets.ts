/**
 * Structured product facts that the scraped catalogue never stored, derived from the Sanity product document.
 *
 * Why this exists: a shopper asking for a "deck-mount faucet" got "I couldn't find an exact match" (or, worse, wall-
 * mounted faucets) because nothing in the catalogue says "deck" — deck-mount is simply the default, and only the
 * wall-mounted models say so in their name. Keyword search for "deck" therefore matched nothing, and the model had no
 * mounting data to reason with. Computing the facts once at sync time (scripts/syncSanityCatalog.ts) and storing them
 * in `products.specifications.facets` / `facet_text` lets retrieval, the prompt and the chip filter all use the same
 * truth.
 */

export type Mounting = "deck" | "wall";

export type Facets = {
  /** Faucets only. Everything not named/described as wall-mounted is deck-mounted (the standard kitchen install). */
  mounting?: Mounting;
  /** Faucets only: pull-out / pull-down spray head. */
  pullOut?: boolean;
  /** Normalised finish names, e.g. "Matte Black", "Chrome". */
  finishes: string[];
};

export type FacetInput = {
  /** Database category: Sink | Faucet | Appliance | Hob | Disposer | Accessory | Combo. */
  category: string;
  name: string;
  description?: string | null;
  attributes?: Array<{ label?: string | null; value?: string | null }> | null;
  colors?: Array<string | null | undefined> | null;
};

const WALL_MOUNT = /wall[\s-]*mount(?:ed)?|\bwmf\b/i;
const PULL_OUT = /pull[\s-]?out|pull[\s-]?down|spray(?:er)?/i;

const FINISH_ATTRIBUTE_LABELS = /^(available finishes|finish|finish detail|color|colour)$/i;
const SERIES_LABEL = /^series$/i;

/** "Matt Black" / "matte black" / "BLACK MATTE" → "Matte Black"; leaves other names title-cased. */
export function normaliseFinish(raw: string): string {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (/^(matt|matte)\s+black$|^black\s+(matt|matte)$/i.test(cleaned)) return "Matte Black";
  return cleaned
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\bPvd\b/g, "PVD");
}

function splitFinishList(value: string): string[] {
  return value
    .split(/[,/;|]|\band\b|\+/i)
    .map((part) => normaliseFinish(part))
    .filter((part) => part.length > 0 && part.length <= 40);
}

export function deriveFacets(input: FacetInput): Facets {
  const attrs = (input.attributes ?? []).filter((a): a is { label: string; value: string } =>
    Boolean(a?.label && a?.value)
  );
  const finishes = new Set<string>();

  for (const attr of attrs) {
    if (FINISH_ATTRIBUTE_LABELS.test(attr.label.trim())) {
      for (const finish of splitFinishList(attr.value)) finishes.add(finish);
    }
  }
  for (const color of input.colors ?? []) {
    if (color) {
      const finish = normaliseFinish(color);
      if (finish) finishes.add(finish);
    }
  }

  const facets: Facets = { finishes: Array.from(finishes) };

  if (input.category === "Faucet") {
    const series = attrs.find((a) => SERIES_LABEL.test(a.label.trim()))?.value ?? "";
    const wall = WALL_MOUNT.test(input.name) || WALL_MOUNT.test(series) || WALL_MOUNT.test(input.description ?? "");
    facets.mounting = wall ? "wall" : "deck";

    const pullText = [input.name, input.description ?? "", ...attrs.map((a) => `${a.label} ${a.value}`)].join(" ");
    facets.pullOut = PULL_OUT.test(pullText);
  }

  return facets;
}

/** One-line, human/LLM-readable summary, e.g. "Deck-mounted · Pull-out spray · Finishes: Chrome, Matte Black". */
export function facetText(facets: Facets): string {
  const parts: string[] = [];
  if (facets.mounting === "deck") parts.push("Deck-mounted");
  if (facets.mounting === "wall") parts.push("Wall-mounted");
  if (facets.pullOut) parts.push("Pull-out spray");
  if (facets.finishes.length > 0) parts.push(`Finishes: ${facets.finishes.join(", ")}`);
  return parts.join(" · ");
}
