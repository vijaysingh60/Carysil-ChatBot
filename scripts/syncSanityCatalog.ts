import { getDbPool } from "../lib/db";
import { createEmbedding, embeddingToSqlVector } from "../lib/embeddings";
import { deriveFacets, facetText, type Facets } from "../lib/catalogFacets";

/**
 * Syncs the chatbot's `products` table with the product catalogue in Sanity (the carysil.com source of truth).
 *
 * What it does
 *   - Matches each visible Sanity product to an existing row (by id = slug, by the slug inside the old URL, or by
 *     normalised name) and refreshes it: name, description, material, features, canonical carysil.com URL, and the
 *     structured facts in lib/catalogFacets.ts (faucet mounting, pull-out spray, finishes) that the scraped data
 *     never had. This is what lets "deck-mount faucets" find faucets instead of dead-ending.
 *   - Inserts Sanity products the chatbot has never heard of (with embeddings).
 *   - Reports active chatbot rows that no longer exist in Sanity. It only deactivates them with --deactivate-missing.
 *
 * Safety
 *   - Dry run by default. Nothing is written without --apply.
 *   - Refuses a non-local database unless --allow-remote is also passed, and prints the target host first.
 *   - All writes happen in one transaction, after embeddings are computed, so a failure leaves the table untouched.
 *
 * Usage (Sanity credentials live in the website repo's .env; pass both files so nothing is copied):
 *   node --env-file=.env.local --env-file="../../Carysil/.env" --import tsx scripts/syncSanityCatalog.ts [--apply]
 *     [--allow-remote] [--skip-embeddings] [--deactivate-missing]
 *
 * Needs: NEXT_PUBLIC_SANITY_PROJECT_ID, NEXT_PUBLIC_SANITY_DATASET, SANITY_API_READ_TOKEN, DATABASE_URL, and the
 * embedding service (EMBEDDING_API_URL) unless --skip-embeddings.
 */

const SITE_URL = "https://carysil.com";
const CX_COLLECTION_SLUGS = new Set(["linear-collection", "eclipse", "vitroceramic", "matrix", "rustic", "cx-sinks"]);

type SanityAttribute = { label?: string | null; value?: string | null };

type SanityProduct = {
  _id: string;
  name: string;
  slug: string;
  description?: string | null;
  specs?: string[] | null;
  material?: string | null;
  finish?: string | null;
  colors?: Array<{ name?: string | null }> | null;
  size?: string | null;
  attributes?: SanityAttribute[] | null;
  categorySlug?: string | null;
  parentSlug?: string | null;
  imageUrl?: string | null;
};

type DbRow = {
  id: string;
  name: string;
  category: string;
  material: string | null;
  style: string | null;
  size: string | null;
  description: string | null;
  url: string | null;
  image_url: string | null;
  is_active: boolean;
  specifications: Record<string, unknown> | null;
};

type PlannedRow = {
  id: string;
  isNew: boolean;
  reactivate: boolean;
  name: string;
  category: string;
  material: string | null;
  style: string | null;
  size: string | null;
  description: string | null;
  features: string[];
  specifications: Record<string, unknown>;
  url: string;
  imageUrl: string | null;
  searchText: string;
  embeddingText: string;
  facets: Facets;
};

const GROQ = `*[_type == "product" && archived != true]{
  _id, name, "slug": slug.current, description, specs, material, finish, colors[]{name}, size,
  attributes[]{label, value},
  "categorySlug": category->slug.current,
  "parentSlug": category->parent->slug.current,
  "imageUrl": coalesce(mainImage.asset->url, gallery[0].asset->url)
}`;

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function normaliseName(text: string): string {
  return decodeEntities(text).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

async function fetchSanityProducts(): Promise<SanityProduct[]> {
  const projectId = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID;
  const dataset = process.env.NEXT_PUBLIC_SANITY_DATASET;
  const token = process.env.SANITY_API_READ_TOKEN;
  const apiVersion = process.env.NEXT_PUBLIC_SANITY_API_VERSION || "2026-07-13";
  if (!projectId || !dataset || !token) {
    throw new Error(
      "Missing Sanity credentials. Run with --env-file for the website's .env (NEXT_PUBLIC_SANITY_PROJECT_ID, NEXT_PUBLIC_SANITY_DATASET, SANITY_API_READ_TOKEN)."
    );
  }
  const url = `https://${projectId}.api.sanity.io/v${apiVersion}/data/query/${dataset}?query=${encodeURIComponent(GROQ)}&perspective=published`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Sanity query failed (${response.status}): ${await response.text()}`);
  const payload = (await response.json()) as { result?: SanityProduct[] };
  if (!Array.isArray(payload.result)) throw new Error("Sanity returned no result array");
  return payload.result;
}

function dbCategoryFor(p: SanityProduct): string {
  const leaf = p.categorySlug ?? "";
  const parent = p.parentSlug ?? "";
  if (leaf === "faucets" || parent === "kitchen-faucets") return "Faucet";
  if (leaf === "food-waste-disposer") return "Disposer";
  if (leaf === "sink-accessories" || parent === "sink-accessories") return "Accessory";
  if (["quartz-sinks", "stainless-steel-sinks", "kitchen-sinks"].includes(parent) || leaf === "cx-sinks") return "Sink";
  if (leaf === "built-in-hob" || leaf === "cooktop" || (/\b(hob|cooktop)s?\b/i.test(p.name) && !/chimney/i.test(p.name))) {
    return "Hob";
  }
  return "Appliance";
}

function siteUrlFor(p: SanityProduct): string {
  const category = p.categorySlug ?? "";
  return CX_COLLECTION_SLUGS.has(category)
    ? `${SITE_URL}/cx/${p.slug}`
    : `${SITE_URL}/products/${category}/${p.slug}`;
}

function planRow(p: SanityProduct, existing: DbRow | undefined): PlannedRow {
  const name = decodeEntities(p.name);
  const category = existing?.category ?? dbCategoryFor(p);
  const attributes = (p.attributes ?? []).filter((a) => a?.label && a?.value);
  const sanityMaterial =
    p.material?.trim() || attributes.find((a) => /^material$/i.test(a.label!.trim()))?.value?.trim() || null;
  const description = p.description?.trim() ? decodeEntities(p.description) : (existing?.description ?? null);

  const facets = deriveFacets({
    category,
    name,
    description,
    attributes,
    colors: [...(p.colors ?? []).map((c) => c?.name), p.finish],
  });
  const text = facetText(facets);

  const features = [
    ...attributes.map((a) => `${a.label!.trim()}: ${decodeEntities(a.value!)}`),
    ...(p.specs ?? []).map((s) => decodeEntities(s)),
    ...(text ? [text] : []),
  ];

  const material = sanityMaterial ?? existing?.material ?? null;
  const style = existing?.style ?? null;
  const size = p.size?.trim() || existing?.size || null;

  const specifications: Record<string, unknown> = {
    ...(existing?.specifications ?? {}),
    facets,
    facet_text: text,
    sanity: { id: p._id, slug: p.slug, category: p.categorySlug ?? null, synced_at: new Date().toISOString() },
  };

  const searchText = [name, category, material, style, size, description, features.join(" ")]
    .filter(Boolean)
    .join(" \n ");
  const embeddingText = [
    `Name: ${name}`,
    `Category: ${category}`,
    `Material: ${material ?? ""}`,
    `Style: ${style ?? ""}`,
    `Description: ${description ?? ""}`,
    `Features: ${features.join(", ")}`,
  ].join("\n");

  return {
    id: existing?.id ?? p.slug,
    isNew: !existing,
    reactivate: Boolean(existing && !existing.is_active),
    name,
    category,
    material,
    style,
    size,
    description,
    features,
    specifications,
    url: siteUrlFor(p),
    imageUrl: existing?.image_url ?? p.imageUrl ?? null,
    searchText,
    embeddingText,
    facets,
  };
}

async function embedWithRetry(text: string): Promise<number[]> {
  // lib/embeddings.ts skips the service for 20 s after any failure (e.g. a slow Render wake-up), so wait it out.
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await createEmbedding(text);
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 21_000));
    }
  }
  throw new Error("unreachable");
}

async function run(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const apply = args.has("--apply");
  const allowRemote = args.has("--allow-remote");
  const skipEmbeddings = args.has("--skip-embeddings");
  const deactivateMissing = args.has("--deactivate-missing");

  const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || "";
  const host = /@([^/:?]+)/.exec(dbUrl)?.[1] ?? "unknown";
  const isLocal = ["127.0.0.1", "localhost", "::1"].includes(host);
  console.log(`Target database host: ${host}${isLocal ? " (local)" : " (REMOTE)"}`);
  console.log(apply ? "Mode: APPLY (will write)" : "Mode: dry run (no writes). Pass --apply to write.");
  if (apply && !isLocal && !allowRemote) {
    throw new Error("Refusing to write to a remote database without --allow-remote.");
  }

  const sanityProducts = await fetchSanityProducts();
  console.log(`Sanity: ${sanityProducts.length} visible products`);

  const pool = getDbPool();
  const { rows: dbRows } = await pool.query<DbRow>(
    `SELECT id, name, category, material, style, size, description, url, image_url, is_active, specifications FROM products`
  );
  console.log(`Chatbot DB: ${dbRows.length} rows (${dbRows.filter((r) => r.is_active).length} active)`);

  const byId = new Map(dbRows.map((r) => [r.id, r]));
  const byUrlSlug = new Map<string, DbRow>();
  const byName = new Map<string, DbRow[]>();
  for (const row of dbRows) {
    const slug = /\/products?\/(?:[^/]+\/)?([^/?#]+)\/?(?:[?#].*)?$/.exec(row.url ?? "")?.[1];
    if (slug && (!byUrlSlug.has(slug) || row.is_active)) byUrlSlug.set(slug, row);
    const key = normaliseName(row.name);
    byName.set(key, [...(byName.get(key) ?? []), row]);
  }

  const claimed = new Set<string>();
  const planned: PlannedRow[] = [];
  for (const product of sanityProducts) {
    const nameMatches = (byName.get(normaliseName(product.name)) ?? []).sort(
      (a, b) => Number(b.is_active) - Number(a.is_active)
    );
    const candidate = byId.get(product.slug) ?? byUrlSlug.get(product.slug) ?? nameMatches[0];
    const existing = candidate && !claimed.has(candidate.id) ? candidate : undefined;
    if (existing) claimed.add(existing.id);
    planned.push(planRow(product, existing));
  }

  const inserts = planned.filter((p) => p.isNew);
  const updates = planned.filter((p) => !p.isNew);
  const reactivations = updates.filter((p) => p.reactivate);
  const missing = dbRows.filter((r) => r.is_active && !claimed.has(r.id));

  const mounting = { deck: 0, wall: 0 };
  for (const p of planned) if (p.facets.mounting) mounting[p.facets.mounting]++;

  console.log(`\nPlan: update ${updates.length}, insert ${inserts.length}, reactivate ${reactivations.length}`);
  console.log(`Faucet mounting derived: deck=${mounting.deck}, wall=${mounting.wall}`);
  if (inserts.length) {
    console.log("\nNew products to insert:");
    for (const p of inserts) console.log(`  + [${p.category}] ${p.name}  (${p.id})`);
  }
  if (reactivations.length) {
    console.log("\nInactive rows that Sanity lists as live (will be reactivated):");
    for (const p of reactivations) console.log(`  ~ [${p.category}] ${p.name}  (${p.id})`);
  }
  console.log(`\nActive chatbot rows with no match in Sanity: ${missing.length}${deactivateMissing ? " (will be deactivated)" : " (left as is)"}`);
  for (const r of missing) console.log(`  ? [${r.category}] ${r.name}  (${r.id})`);

  if (!apply) {
    console.log("\nDry run finished. Re-run with --apply to write these changes.");
    await pool.end();
    return;
  }

  const embeddings = new Map<string, string>();
  if (!skipEmbeddings) {
    console.log(`\nEmbedding ${planned.length} rows...`);
    let done = 0;
    for (const p of planned) {
      embeddings.set(p.id, embeddingToSqlVector(await embedWithRetry(p.embeddingText)));
      if (++done % 50 === 0) console.log(`  ${done}/${planned.length}`);
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const p of planned) {
      const vector = embeddings.get(p.id) ?? null;
      await client.query(
        `INSERT INTO products (
           id, name, category, material, style, size, description, features, specifications,
           url, image_url, is_active, search_text, embedding, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,true,$12,$13::vector,NOW())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           material = EXCLUDED.material,
           size = EXCLUDED.size,
           description = EXCLUDED.description,
           features = EXCLUDED.features,
           specifications = EXCLUDED.specifications,
           url = EXCLUDED.url,
           image_url = COALESCE(products.image_url, EXCLUDED.image_url),
           is_active = true,
           search_text = EXCLUDED.search_text,
           embedding = COALESCE(EXCLUDED.embedding, products.embedding),
           updated_at = NOW()`,
        [
          p.id, p.name, p.category, p.material, p.style, p.size, p.description,
          JSON.stringify(p.features), JSON.stringify(p.specifications),
          p.url, p.imageUrl, p.searchText, vector,
        ]
      );
    }
    if (deactivateMissing && missing.length > 0) {
      await client.query(`UPDATE products SET is_active = false, updated_at = NOW() WHERE id = ANY($1::text[])`, [
        missing.map((r) => r.id),
      ]);
    }
    await client.query("COMMIT");
    console.log(`\nDone. Updated ${updates.length}, inserted ${inserts.length}${deactivateMissing ? `, deactivated ${missing.length}` : ""}.`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((error) => {
  console.error("Sanity sync failed:", error);
  process.exit(1);
});
