import { getDbPool } from "@/lib/db";
import { createLru } from "@/lib/cache";
import type { IntentResult } from "@/lib/concierge";
import { inferProductContextFromText } from "./intent";

export type Product = {
  id: string;
  name: string;
  category: string;
  size?: string | null;
  style: string;
  material: string;
  price_range: string;
  description: string;
  price?: string;
  image_url?: string;
  url?: string;
  collection?: string;
};

type ProductRow = {
  id: string;
  name: string;
  category: string;
  material: string | null;
  style: string | null;
  size: string | null;
  description: string | null;
  price: string | null;
  url: string | null;
  image_url: string | null;
  specifications: Record<string, unknown> | null;
};

function rowToProduct(row: ProductRow): Product {
  const specs = row.specifications ?? {};
  const collections = specs.collections;
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    size: row.size ?? undefined,
    style: row.style ?? "",
    material: row.material ?? "",
    price_range: typeof specs.price_range === "string" ? specs.price_range : "",
    description: row.description ?? "",
    price: row.price ?? undefined,
    image_url: row.image_url ?? undefined,
    url: row.url ?? undefined,
    collection: Array.isArray(collections) ? String(collections[0]) : undefined,
  };
}

// Full catalogue is small (~600 rows); cache it briefly per-process instead
// of hitting Postgres on every fallback lookup.
const catalogCache = createLru<Product[]>({ max: 1, ttlMs: 60_000 });
const CATALOG_CACHE_KEY = "all_active_products";

/** All active products from the `products` table (source of truth — replaces the old data/products.json catalogue). */
export async function fetchAllActiveProducts(): Promise<Product[]> {
  const cached = catalogCache.get(CATALOG_CACHE_KEY);
  if (cached) return cached;

  const pool = getDbPool();
  const { rows } = await pool.query<ProductRow>(
    `SELECT id, name, category, material, style, size, description, price, url, image_url, specifications
     FROM products
     WHERE is_active = true`
  );
  const products = rows.map(rowToProduct);
  catalogCache.set(CATALOG_CACHE_KEY, products);
  return products;
}

/** Look up specific products by id directly from the database. */
export async function fetchProductsByIds(ids: string[]): Promise<Map<string, Product>> {
  const map = new Map<string, Product>();
  if (ids.length === 0) return map;
  const pool = getDbPool();
  const { rows } = await pool.query<ProductRow>(
    `SELECT id, name, category, material, style, size, description, price, url, image_url, specifications
     FROM products
     WHERE id = ANY($1::text[])`,
    [ids]
  );
  for (const row of rows) {
    map.set(row.id, rowToProduct(row));
  }
  return map;
}

export function dedupeProductsById(products: Product[]): Product[] {
  const seen = new Set<string>();
  return products.filter((product) => {
    if (seen.has(product.id)) return false;
    seen.add(product.id);
    return true;
  });
}

function normalizeSizeToken(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "");
}

function extractCmFromText(s: string): string | null {
  const m = s.match(/\b(\d{2,3})\s*cm\b/i);
  return m ? `${m[1]}cm` : null;
}

export async function filterByIntent(intent: IntentResult): Promise<Product[]> {
  const allProducts = await fetchAllActiveProducts();
  if (!intent.categories?.length) {
    return allProducts;
  }
  const f = intent.filters;
  const keywordList: string[] =
    f?.keywords == null
      ? []
      : Array.isArray(f.keywords)
        ? (f.keywords as unknown[]).map((k) => String(k))
        : [String(f.keywords)];

  const rawCats = intent.categories as string[];
  const expanded = new Set<string>();
  const wantsChimney = keywordList.map((k) => k.toLowerCase()).includes("chimney");
  for (const c of rawCats) {
    expanded.add(c);
    if (c === "Appliance") {
      expanded.add("Hob");
      if (wantsChimney) expanded.add("Combo");
    }
  }
  let list = allProducts.filter((p) => expanded.has(p.category));
  if (keywordList.length > 0 && intent.categories.length === 1 && intent.categories[0] === "Appliance") {
    const hay = (p: Product) => `${p.name} ${p.description ?? ""}`.toLowerCase();
    const kws = keywordList.map((k) => String(k).toLowerCase());
    const wantsHob = kws.includes("hob");
    const wantsCookingRange = kws.includes("cooking range");
    list = list.filter((p) => {
      const h = hay(p);
      const matchesAny = kws.some((k) => (k === "hob" ? /\bhob\b|\bburner\b|\bburners\b/.test(h) : h.includes(k)));
      if (!matchesAny) return false;
      if (wantsHob && !wantsCookingRange && /\b(cooking\s*range|freestanding\s*range|standing\s*range)\b/.test(h)) return false;
      return true;
    });
  }
  if (f?.material) {
    const m = f.material.toLowerCase();
    list = list.filter(
      (p) => p.material?.toLowerCase().includes(m) || m.split(/\s+/).some((w) => p.material?.toLowerCase().includes(w))
    );
  }
  if (f?.price_range) {
    const pr = f.price_range.toLowerCase();
    list = list.filter(
      (p) => p.price_range?.toLowerCase() === pr || p.price_range?.toLowerCase().includes(pr)
    );
  }
  if (f?.style) {
    const s = f.style.toLowerCase();
    list = list.filter(
      (p) => p.style?.toLowerCase().includes(s) || s.split(/\s+/).some((w) => p.style?.toLowerCase().includes(w))
    );
  }
  if (f?.size) {
    const sz = normalizeSizeToken(String(f.size));
    const listHasAnySize = list.some((p) => p.size != null && String(p.size).trim().length > 0);
    const filtered = list.filter((p) => {
      const direct = p.size != null ? normalizeSizeToken(String(p.size)) : "";
      const derived = extractCmFromText(`${p.name} ${p.description ?? ""}`) || "";
      const candidate = direct || derived;
      if (!candidate) return false;
      return candidate.includes(sz) || sz.includes(candidate);
    });
    if (filtered.length > 0 || listHasAnySize) {
      list = filtered;
    }
  }
  return list.length > 0 ? list : allProducts.filter((p) => expanded.has(p.category));
}

export function getSearchCategories(message: string, intent: IntentResult): string[] | undefined {
  if (!intent.categories?.length) return undefined;
  if (intent.categories.includes("Combo") && /\bcombo|combos\b/i.test(message)) {
    return ["Combo"];
  }
  return intent.categories;
}

export function enrichProductIntent(message: string, intent: IntentResult): IntentResult {
  if (intent.dealer_intent) return intent;
  const inferred = inferProductContextFromText(message);
  if (!inferred?.keywords?.length) return intent;

  const existingKeywords = Array.isArray(intent.filters?.keywords)
    ? intent.filters.keywords
    : intent.filters?.keywords
      ? [String(intent.filters.keywords)]
      : [];

  return {
    ...intent,
    categories: intent.categories.length > 0 ? intent.categories : [inferred.category],
    filters: {
      ...intent.filters,
      keywords: Array.from(new Set([...existingKeywords, ...inferred.keywords])),
    },
  };
}
