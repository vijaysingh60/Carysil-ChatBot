import fs from "node:fs";
import path from "node:path";
import { getDbPool } from "../lib/db";
import { createEmbedding, embeddingToSqlVector } from "../lib/embeddings";

/**
 * Imports scraped knowledge-base content (FAQs today; guides/manuals/spec-sheets
 * later) from data/documents/*.json into the `documents` table for RAG-grounded
 * installation/support answers. Mirrors the embed-and-upsert pattern in
 * scripts/importCatalogProducts.ts.
 *
 * Usage:
 *   node --import tsx scripts/importDocuments.ts [--dry-run] [--skip-embeddings]
 */

type RawFaq = {
  id: string;
  category: string;
  category_slug: string;
  question: string;
  answer: string;
  source_url: string;
};

type DocumentRow = {
  id: string;
  title: string;
  document_type: string;
  content: string;
  url: string | null;
  product_id: string | null;
};

const DATA_ROOT = path.resolve(process.cwd(), "data", "documents");

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

function loadFaqs(): DocumentRow[] {
  const filePath = path.join(DATA_ROOT, "faqs.json");
  if (!fs.existsSync(filePath)) return [];
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as RawFaq[];
  return raw.map((faq) => ({
    id: faq.id,
    title: faq.question,
    document_type: "faq",
    content: faq.answer,
    url: faq.source_url ?? null,
    product_id: null,
  }));
}

function buildEmbeddingText(row: DocumentRow): string {
  return `${row.title}\n${row.content}`;
}

async function upsertDocument(row: DocumentRow, embedding: number[] | null): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `
    INSERT INTO documents (id, title, document_type, content, url, product_id, embedding, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7::vector, NOW())
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      document_type = EXCLUDED.document_type,
      content = EXCLUDED.content,
      url = EXCLUDED.url,
      product_id = EXCLUDED.product_id,
      embedding = COALESCE(EXCLUDED.embedding, documents.embedding),
      updated_at = NOW()
    `,
    [
      row.id,
      row.title,
      row.document_type,
      row.content,
      row.url,
      row.product_id,
      embedding ? embeddingToSqlVector(embedding) : null,
    ]
  );
}

async function run(): Promise<void> {
  loadLocalEnv();
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  const skipEmbeddings = args.has("--skip-embeddings");

  const rows = loadFaqs();
  console.log(`Loaded ${rows.length} document rows from data/documents/.`);

  if (rows.length === 0) {
    console.log("Nothing to import. Run `npm run scrape:faqs` in ../scraping first.");
    return;
  }

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

    await upsertDocument(row, embedding);
    if ((i + 1) % 25 === 0 || i + 1 === rows.length) {
      console.log(`Upserted ${i + 1}/${rows.length} documents (embedded ${embedded}, failed ${failed}).`);
    }
  }

  // Below ~5,000 rows an IVFFlat ANN index is a net negative — see the same
  // fix in scripts/importCatalogProducts.ts for the measured failure mode
  // (an under-sized index returning far fewer than LIMIT rows, silently
  // dropping the true nearest neighbor). A sequential scan is exact and
  // costs single-digit milliseconds at this corpus size.
  if (embedded > 0) {
    const pool = getDbPool();
    const ANN_INDEX_ROW_THRESHOLD = 5000;
    await pool.query(`DROP INDEX IF EXISTS documents_embedding_cosine_idx`);
    if (rows.length >= ANN_INDEX_ROW_THRESHOLD) {
      const lists = Math.max(1, Math.round(Math.sqrt(rows.length)));
      await pool.query(
        `CREATE INDEX documents_embedding_cosine_idx ON documents
         USING ivfflat (embedding vector_cosine_ops) WITH (lists = ${lists})`
      );
      console.log(`Rebuilt documents_embedding_cosine_idx (lists=${lists}).`);
    } else {
      console.log(
        `Skipped ANN index (${rows.length} rows < ${ANN_INDEX_ROW_THRESHOLD} threshold) — relying on exact sequential scan.`
      );
    }
  }

  console.log("Document import completed.");
}

run()
  .catch((error) => {
    console.error("Document import failed:", error);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });
