import fs from "node:fs";
import path from "node:path";
import products from "../data/products.json";
import { createEmbedding } from "../lib/embeddings";
import { ensureVectorSchema, upsertProductEmbedding, type ProductRecord } from "../lib/vectorStore";

type SourceProduct = ProductRecord & {
  collection?: string | null;
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

function buildEmbeddingText(product: SourceProduct): string {
  return [
    `Name: ${product.name}`,
    `Category: ${product.category}`,
    `Material: ${product.material ?? ""}`,
    `Style: ${product.style ?? ""}`,
    `Description: ${product.description ?? ""}`,
    `Collection: ${product.collection ?? ""}`,
  ].join("\n");
}

function dedupeProductsById(products: SourceProduct[]): SourceProduct[] {
  const seen = new Set<string>();
  return products.filter((product) => {
    if (seen.has(product.id)) return false;
    seen.add(product.id);
    return true;
  });
}

async function run(): Promise<void> {
  loadLocalEnv();
  const allProducts = dedupeProductsById(products as SourceProduct[]);
  if (allProducts.length === 0) {
    throw new Error("No products found in data/products.json");
  }

  await ensureVectorSchema();
  console.log(`Preparing embeddings for ${allProducts.length} products...`);

  for (let index = 0; index < allProducts.length; index += 1) {
    const product = allProducts[index];
    const embeddingText = buildEmbeddingText(product);
    const embedding = await createEmbedding(embeddingText);
    await upsertProductEmbedding(product, embedding);
    if ((index + 1) % 25 === 0 || index + 1 === allProducts.length) {
      console.log(`Embedded ${index + 1}/${allProducts.length}`);
    }
  }

  console.log("Product embedding sync completed.");
}

run().catch((error) => {
  console.error("Embedding generation failed:", error);
  process.exit(1);
});
