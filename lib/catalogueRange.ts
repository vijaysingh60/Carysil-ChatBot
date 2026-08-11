import { getDbPool } from "@/lib/db";
import { createLru } from "@/lib/cache";
import type { ProductCategory } from "@/lib/concierge";

/**
 * Single source of truth for "what does Carysil actually sell?".
 *
 * The `products.category` column is coarse (Sink / Faucet / Appliance / Hob /
 * Disposer / Accessory / Combo), but each row also carries the scraped leaf
 * slugs in `specifications.collections` — which is what a shopper means when
 * they ask "what appliances do you have?" (chimneys, ovens, wine chillers...).
 * That field was previously written by the import script but never read at
 * runtime.
 *
 * Everything here is derived from live rows, so the bot can never advertise a
 * category it has no stock in (e.g. Combo currently has zero active products
 * and therefore never appears).
 */

export type RangeEntry = { label: string; count: number };

/** Display labels for the coarse category column. */
const CATEGORY_LABELS: Record<string, string> = {
  Sink: "Kitchen Sinks",
  Faucet: "Kitchen Faucets",
  Hob: "Hobs & Cooktops",
  Appliance: "Kitchen Appliances",
  Disposer: "Food Waste Disposers",
  Accessory: "Sink Accessories",
  Combo: "Sink & Faucet Combos",
};

/** Order used when listing top-level categories (most substantial ranges first). */
const CATEGORY_ORDER = ["Sink", "Faucet", "Hob", "Appliance", "Disposer", "Accessory", "Combo"];

/**
 * Leaf-slug → display label. The two scrape sources spell the same thing
 * differently (`built-in-hob`/`built-in-hobs`, `quartz-sinks`/`quartz-sink`,
 * `oven`/`built-in-oven`), and several one-off slugs are really the same
 * shelf, so this map both normalises and groups. Slugs are looked up after
 * `normalizeSlug`, so only one spelling per concept needs an entry here.
 */
const SLUG_LABELS: Record<string, string> = {
  // Sinks
  "stainless steel sink": "Stainless Steel Sinks",
  "quartz sink": "Quartz Sinks",
  "green sink": "Green Sinks",
  "cleaning kit": "Sink Cleaning Kits",
  // Faucets
  faucet: "Kitchen Faucets",
  // Hobs
  hob: "Built-in Hobs",
  cooktop: "Cooktops",
  // Disposers
  "food waste disposer": "Food Waste Disposers",
  // Appliances
  chimney: "Chimneys",
  "wine chiller": "Wine Chillers",
  oven: "Built-in Ovens",
  microwave: "Microwaves",
  dishwasher: "Dishwashers",
  refrigerator: "Refrigerators",
  "ice maker": "Ice Makers",
  barbeque: "Built-in Barbeques",
  fryer: "Built-in Fryers",
  "cooking range": "Cooking Ranges",
  "free standing cooking range": "Cooking Ranges",
  "coffee maker": "Coffee Machines",
  "la carysil coffee machine and grinder": "Coffee Machines",
  "espresso maker": "Coffee Machines",
  "milk frother": "Coffee Machines",
  // Everything countertop-ish collapses into one shelf rather than listing
  // "Toaster (1), Blender (1), Cigar (1)…" which reads like a bug.
  "small appliance": "Small Appliances",
  blender: "Small Appliances",
  toaster: "Small Appliances",
  "rice cooker": "Small Appliances",
  "stand mixer": "Small Appliances",
  "cooker pot": "Small Appliances",
  "electric kettle": "Small Appliances",
  cigar: "Small Appliances",
  // Accessories
  "sink accessorie": "Sink Accessories",
  "waste coupling": "Waste Couplings",
  "soap dispenser": "Soap Dispensers",
  "wire grid": "Wire Grids",
  "vegetable colander": "Vegetable Colanders",
  "fold matt": "Foldable Mats",
  "glass rinser": "Glass Rinsers",
  apron: "Aprons",
  "chopping board": "Chopping Boards",
  "flexible basket": "Flexible Baskets",
};

/** Collapses cross-source slug spellings to a single canonical key. */
export function normalizeSlug(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/^built-in-/, "")
    .replace(/s$/, "")
    .replace(/-/g, " ")
    .trim();
}

function titleCase(text: string): string {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Unknown//future slugs still surface (title-cased) rather than silently vanishing. */
function labelForSlug(slug: string): string {
  const key = normalizeSlug(slug);
  return SLUG_LABELS[key] ?? titleCase(key);
}

type CatalogueRange = {
  /** category → sub-type label → distinct product count */
  byCategory: Map<string, Map<string, number>>;
  /** category → distinct product count */
  categoryTotals: Map<string, number>;
};

type RangeRow = { id: string; category: string; collections: unknown };

// The catalogue changes only when the import script runs, so a 5-minute cache
// is plenty and keeps this off the request path for virtually every turn.
const rangeCache = createLru<CatalogueRange>({ max: 1, ttlMs: 5 * 60_000 });
const RANGE_CACHE_KEY = "catalogue_range";

async function loadCatalogueRange(): Promise<CatalogueRange | null> {
  const cached = rangeCache.get(RANGE_CACHE_KEY);
  if (cached) return cached;

  try {
    const pool = getDbPool();
    const { rows } = await pool.query<RangeRow>(
      `SELECT id, category, specifications->'collections' AS collections
       FROM products
       WHERE is_active = true`
    );

    const byCategory = new Map<string, Map<string, number>>();
    const categoryTotals = new Map<string, number>();

    for (const row of rows) {
      if (!row.category) continue;
      categoryTotals.set(row.category, (categoryTotals.get(row.category) ?? 0) + 1);

      const collections = Array.isArray(row.collections) ? (row.collections as string[]) : [];
      // A product can sit in several collections that map to the SAME label
      // (e.g. `quartz-sinks` + `quartz-sink` after a cross-source merge), so
      // dedupe per product before counting or totals would be inflated.
      const labels = new Set(collections.filter(Boolean).map(labelForSlug));
      if (labels.size === 0) continue;

      const subTypes = byCategory.get(row.category) ?? new Map<string, number>();
      for (const label of Array.from(labels)) {
        subTypes.set(label, (subTypes.get(label) ?? 0) + 1);
      }
      byCategory.set(row.category, subTypes);
    }

    const range: CatalogueRange = { byCategory, categoryTotals };
    rangeCache.set(RANGE_CACHE_KEY, range);
    return range;
  } catch (error) {
    // Never let a range lookup break the turn — callers fall back to their
    // existing copy when this returns null.
    console.error("[catalogueRange] failed to load catalogue range", error);
    return null;
  }
}

function sortEntries(counts: Map<string, number>): RangeEntry[] {
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * Sub-types stocked within a category, most substantial first.
 * `Appliance` folds in the separate `Hob` category — a shopper asking about
 * "kitchen appliances" plainly means hobs and cooktops too.
 */
export async function getCategoryRange(category: ProductCategory | string): Promise<RangeEntry[]> {
  const range = await loadCatalogueRange();
  if (!range) return [];

  const merged = new Map<string, number>();
  const sourceCategories = category === "Appliance" ? ["Appliance", "Hob"] : [category];
  for (const cat of sourceCategories) {
    for (const [label, count] of Array.from(range.byCategory.get(cat) ?? [])) {
      merged.set(label, (merged.get(label) ?? 0) + count);
    }
  }
  return sortEntries(merged);
}

/** Top-level categories that actually have stock. */
export async function getTopLevelRange(): Promise<RangeEntry[]> {
  const range = await loadCatalogueRange();
  if (!range) return [];

  return Array.from(range.categoryTotals.entries())
    .filter(([, count]) => count > 0)
    .map(([category, count]) => ({ label: CATEGORY_LABELS[category] ?? titleCase(category), count }))
    .sort(
      (a, b) =>
        CATEGORY_ORDER.indexOf(categoryForLabel(a.label)) - CATEGORY_ORDER.indexOf(categoryForLabel(b.label))
    );
}

function categoryForLabel(label: string): string {
  const hit = Object.entries(CATEGORY_LABELS).find(([, value]) => value === label);
  return hit ? hit[0] : label;
}

/** Comma list with a trailing "and", e.g. "Chimneys, Ovens and Dishwashers". */
export function formatRangeList(entries: RangeEntry[]): string {
  const labels = entries.map((entry) => entry.label);
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * Live-data replacement for the hardcoded "We have hobs, chimneys, and
 * dishwashers" copy. Returns null when the catalogue can't be read so callers
 * keep their existing static wording.
 *
 * `limit` caps how many sub-types are named inline — the appliance range runs to
 * 14 entries, which is right for a dedicated range answer but far too long for a
 * one-line clarification prompt.
 */
export async function describeCategoryRange(
  category: ProductCategory | string,
  limit?: number
): Promise<string | null> {
  const entries = await getCategoryRange(category);
  if (entries.length < 2) return null;
  if (limit && entries.length > limit) {
    return `${formatRangeList(entries.slice(0, limit))} and more`;
  }
  return formatRangeList(entries);
}
