import { embeddingCache } from "@/lib/cache";

export const EMBEDDING_DIMENSION = 384;

type EmbedResponse = {
  embedding: number[];
};

function normalizeKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

async function fetchEmbedding(text: string): Promise<number[]> {
  const baseUrl = process.env.EMBEDDING_API_URL || "http://127.0.0.1:5001";
  const response = await fetch(`${baseUrl}/embed`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
    cache: "no-store",
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Embedding API failed (${response.status}): ${body}`);
  }

  const payload = (await response.json()) as EmbedResponse;
  if (!Array.isArray(payload.embedding) || payload.embedding.length !== EMBEDDING_DIMENSION) {
    throw new Error("Embedding API returned invalid embedding");
  }

  return payload.embedding;
}

export async function createEmbedding(text: string): Promise<number[]> {
  const key = normalizeKey(text);
  if (key.length === 0) {
    return fetchEmbedding(text);
  }
  const cached = embeddingCache.get(key);
  if (cached) return cached;
  const fresh = await fetchEmbedding(text);
  embeddingCache.set(key, fresh);
  return fresh;
}

export function embeddingToSqlVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
