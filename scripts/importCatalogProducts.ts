import fs from "node:fs";
import path from "node:path";
import { getDbPool } from "../lib/db";
import { createEmbedding, embeddingToSqlVector } from "../lib/embeddings";

/**
 * Imports the scraped catalogue in data/categories (carysil.com) and
 * data/categories2 (carysilshop.com) into the `products` table.
 *
 * Both folders describe overlapping real-world products (carysil.com is the
 * marketing catalogue, carysilshop.com is the storefront with pricing), and
 * individual category files within a folder can list the same product twice
 * (e.g. a sink appearing in both green-sinks.json and quartz-sinks.json).
 * This script merges those duplicates into a single row per product id
 * instead of failing on the primary key or silently overwriting data.
 *
 * Usage:
 *   node --import tsx scripts/importCatalogProducts.ts [--dry-run] [--skip-embeddings]
 */

type RawProduct = {
  id: string;
  name: string;
  category: string;
  material?: string | null;
  style?: string | null;
  size?: string | null;
  description?: string | null;
  price?: string | null;
  price_range?: string | null;
  compare_at_price?: string | null;
  image_url?: string | null;
  url?: string | null;
  collection?: string | null;
  technical_details?: Record<string, string> | null;
  colours_available?: string[] | null;
  scraped_at?: string | null;
};

type SourceFolder = { dir: string; source: string };

const SOURCE_FOLDERS: SourceFolder[] = [
  { dir: "categories", source: "carysil.com" },
  { dir: "categories2", source: "carysilshop.com" },
];

const DATA_ROOT = path.resolve(process.cwd(), "data");

type LoadedProduct = RawProduct & {
  _source: string;
  _file: string;
};

type MergedProduct = {
  primary: LoadedProduct;
  duplicates: LoadedProduct[];
};

function loadLocalEnv(): void {
  const candidates = [".env.local", ".env"];
  for (const fileName of candidates) {
    const filePath = path.resolve(process.cwd(), fileName);
    if (!fs.existsSync(filePath)) continue;
    const raw = fs.readFileSync(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex <= 0) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}

function loadFolder(folder: SourceFolder): LoadedProduct[] {
  const dirPath = path.join(DATA_ROOT, folder.dir);
  const files = fs
    .readdirSync(dirPath)
    .filter((f) => f.endsWith(".json") && f !== "categories.json");

  const items: LoadedProduct[] = [];
  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as RawProduct[];
    for (const item of raw) {
      if (!item?.id || !item?.name || !item?.category) continue;
      items.push({ ...item, _source: folder.source, _file: `${folder.dir}/${file}` });
    }
  }
  return items;
}

/** Numeric price parsed from strings like "Rs. 1,59,990.00" -> 159990.00 */
function parsePrice(price?: string | null): number | null {
  if (!price) return null;
  // Strip currency labels first — "Rs." carries a period that would otherwise
  // corrupt the numeric parse (e.g. "Rs. 16,890.00" -> ".16890.00" -> 0.1689).
  const withoutCurrency = price.replace(/rs\.?|inr|₹/gi, "");
  const digits = withoutCurrency.replace(/[^0-9.]/g, "");
  if (!digits) return null;
  const value = Number.parseFloat(digits);
  return Number.isFinite(value) ? value : null;
}

function scorePrimary(item: LoadedProduct): number {
  let score = 0;
  if (parsePrice(item.price) !== null) score += 2;
  if (item._source === "carysilshop.com") score += 1;
  score += Math.min((item.description?.length ?? 0) / 1000, 1);
  return score;
}

/** Groups items by id, picking the most complete record as primary and folding the rest in as context. */
function dedupe(items: LoadedProduct[]): { merged: MergedProduct[]; duplicateCount: number } {
  const byId = new Map<string, LoadedProduct[]>();
  for (const item of items) {
    const list = byId.get(item.id) ?? [];
    list.push(item);
    byId.set(item.id, list);
  }

  const merged: MergedProduct[] = [];
  let duplicateCount = 0;
  for (const group of Array.from(byId.values())) {
    if (group.length === 1) {
      merged.push({ primary: group[0], duplicates: [] });
      continue;
    }
    duplicateCount += group.length - 1;
    const sorted = [...group].sort((a, b) => scorePrimary(b) - scorePrimary(a));
    merged.push({ primary: sorted[0], duplicates: sorted.slice(1) });
  }
  return { merged, duplicateCount };
}

function buildFeatures(group: MergedProduct): string[] {
  const { primary, duplicates } = group;
  const all = [primary, ...duplicates];
  const features: string[] = [];

  const colours = Array.from(
    new Set(all.flatMap((p) => p.colours_available ?? []).filter(Boolean))
  );
  if (colours.length > 0) {
    features.push(`Available in: ${colours.join(", ")}`);
  }

  const techDetails: Record<string, string> = {};
  for (const p of all) Object.assign(techDetails, p.technical_details ?? {});
  for (const [key, value] of Object.entries(techDetails)) {
    if (value) features.push(`${key}: ${value}`);
  }

  if (primary.price_range) features.push(`Price tier: ${primary.price_range}`);
  if (primary.compare_at_price && primary.compare_at_price !== primary.price) {
    features.push(`Compare at: ${primary.compare_at_price}`);
  }

  return features;
}

function buildSpecifications(group: MergedProduct): Record<string, unknown> {
  const { primary, duplicates } = group;
  const all = [primary, ...duplicates];

  const techDetails: Record<string, string> = {};
  for (const p of all) Object.assign(techDetails, p.technical_details ?? {});

  const collections = Array.from(new Set(all.map((p) => p.collection).filter(Boolean)));
  const sources = Array.from(new Set(all.map((p) => p._source)));
  const colours = Array.from(
    new Set(all.flatMap((p) => p.colours_available ?? []).filter(Boolean))
  );
  const scrapedAt = all
    .map((p) => p.scraped_at)
    .filter(Boolean)
    .sort()
    .pop();

  const spec: Record<string, unknown> = { ...techDetails };
  if (collections.length > 0) spec.collections = collections;
  if (sources.length > 0) spec.sources = sources;
  if (colours.length > 0) spec.colours_available = colours;
  if (primary.price_range) spec.price_range = primary.price_range;
  if (primary.compare_at_price) spec.compare_at_price = primary.compare_at_price;
  if (scrapedAt) spec.scraped_at = scrapedAt;

  return spec;
}

function buildSearchText(
  group: MergedProduct,
  features: string[],
  specifications: Record<string, unknown>
): string {
  const { primary } = group;
  const parts = [
    primary.name,
    primary.category,
    primary.material,
    primary.style,
    primary.size,
    primary.description,
    (specifications.collections as string[] | undefined)?.join(" "),
    features.join(" "),
  ];
  return parts.filter(Boolean).join(" \n ");
}

type ProductRow = {
  id: string;
  name: string;
  category: string;
  material: string | null;
  style: string | null;
  size: string | null;
  description: string | null;
  price: string | null;
  price_min: number | null;
  price_max: number | null;
  features: string[];
  specifications: Record<string, unknown>;
  url: string | null;
  image_url: string | null;
  search_text: string;
};

function transform(group: MergedProduct): ProductRow {
  const { primary } = group;
  const features = buildFeatures(group);
  const specifications = buildSpecifications(group);
  const price = parsePrice(primary.price);

  return {
    id: primary.id,
    name: primary.name,
    category: primary.category,
    material: primary.material ?? null,
    style: primary.style ?? null,
    size: primary.size ?? null,
    description: primary.description ?? null,
    price: primary.price ?? null,
    price_min: price,
    price_max: price,
    features,
    specifications,
    url: primary.url ?? null,
    image_url: primary.image_url ?? null,
    search_text: buildSearchText(group, features, specifications),
  };
}

async function upsertProduct(row: ProductRow, embedding: number[] | null): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `
    INSERT INTO products (
      id, name, category, material, style, size, description,
      price, price_min, price_max, features, specifications,
      url, image_url, search_text, embedding, updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11::jsonb, $12::jsonb,
      $13, $14, $15, $16::vector, NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      category = EXCLUDED.category,
      material = EXCLUDED.material,
      style = EXCLUDED.style,
      size = EXCLUDED.size,
      description = EXCLUDED.description,
      price = EXCLUDED.price,
      price_min = EXCLUDED.price_min,
      price_max = EXCLUDED.price_max,
      features = EXCLUDED.features,
      specifications = EXCLUDED.specifications,
      url = EXCLUDED.url,
      image_url = EXCLUDED.image_url,
      search_text = EXCLUDED.search_text,
      embedding = COALESCE(EXCLUDED.embedding, products.embedding),
      updated_at = NOW()
    `,
    [
      row.id,
      row.name,
      row.category,
      row.material,
      row.style,
      row.size,
      row.description,
      row.price,
      row.price_min,
      row.price_max,
      JSON.stringify(row.features),
      JSON.stringify(row.specifications),
      row.url,
      row.image_url,
      row.search_text,
      embedding ? embeddingToSqlVector(embedding) : null,
    ]
  );
}

function buildEmbeddingText(row: ProductRow): string {
  return [
    `Name: ${row.name}`,
    `Category: ${row.category}`,
    `Material: ${row.material ?? ""}`,
    `Style: ${row.style ?? ""}`,
    `Description: ${row.description ?? ""}`,
    `Features: ${row.features.join(", ")}`,
  ].join("\n");
}

async function run(): Promise<void> {
  loadLocalEnv();
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  const skipEmbeddings = args.has("--skip-embeddings");

  const loaded = SOURCE_FOLDERS.flatMap(loadFolder);
  console.log(`Loaded ${loaded.length} raw product entries from ${SOURCE_FOLDERS.length} folders.`);

  const { merged, duplicateCount } = dedupe(loaded);
  console.log(
    `Deduplicated to ${merged.length} unique products (removed ${duplicateCount} duplicate entries).`
  );

  const dupGroups = merged.filter((g) => g.duplicates.length > 0);
  if (dupGroups.length > 0) {
    console.log(`\nDuplicate products merged (${dupGroups.length}):`);
    for (const g of dupGroups) {
      const files = [g.primary, ...g.duplicates].map((p) => p._file).join(", ");
      console.log(`  - ${g.primary.id} <- ${files}`);
    }
    console.log("");
  }

  const rows = merged.map(transform);

  if (dryRun) {
    console.log("Dry run: no database writes performed.");
    return;
  }

  if (skipEmbeddings) {
    console.log("Skipping embedding generation (--skip-embeddings). Run without the flag later to backfill.");
  }

  let embedded = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    let embedding: number[] | null = null;
    if (!skipEmbeddings) {
      try {
        embedding = await createEmbedding(buildEmbeddingText(row));
        embedded += 1;
      } catch (error) {
        failed += 1;
        if (failed === 1) {
          console.warn(
            `Embedding service unreachable (${(error as Error).message}). Continuing without embeddings; rerun later to backfill.`
          );
        }
      }
    }

    await upsertProduct(row, embedding);
    if ((i + 1) % 50 === 0 || i + 1 === rows.length) {
      console.log(`Upserted ${i + 1}/${rows.length} products (embedded ${embedded}, failed ${failed}).`);
    }
  }

  if (embedded > 0) {
    const pool = getDbPool();
    // Below ~5,000 rows an IVFFlat ANN index is a net negative: verified
    // during the RAG audit that `lists=100` on 586 rows (whatever earlier
    // process created it) combined with pgvector's default `probes=1`
    // returned 1 row for a `LIMIT 10` query where a sequential scan
    // correctly returned all 10 with the true match ranked first — the
    // index was silently starving retrieval. A seq scan over a few thousand
    // rows computing exact cosine distance costs single-digit milliseconds,
    // so there is no latency reason to index this small. Drop rather than
    // rebuild until the catalogue is large enough to need approximate search.
    const ANN_INDEX_ROW_THRESHOLD = 5000;
    await pool.query(`DROP INDEX IF EXISTS products_embedding_cosine_idx`);
    if (rows.length >= ANN_INDEX_ROW_THRESHOLD) {
      const lists = Math.max(1, Math.round(Math.sqrt(rows.length)));
      await pool.query(
        `CREATE INDEX products_embedding_cosine_idx ON products
         USING ivfflat (embedding vector_cosine_ops) WITH (lists = ${lists})`
      );
      console.log(`Rebuilt products_embedding_cosine_idx (lists=${lists}).`);
    } else {
      console.log(
        `Skipped ANN index (${rows.length} rows < ${ANN_INDEX_ROW_THRESHOLD} threshold) — relying on exact sequential scan.`
      );
    }
  }

  console.log("Catalogue import completed.");
}

run()
  .catch((error) => {
    console.error("Catalogue import failed:", error);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });
