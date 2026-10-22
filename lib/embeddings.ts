import { embeddingCache } from "@/lib/cache";

export const EMBEDDING_DIMENSION = 384;

type EmbedResponse = {
  embedding: number[];
};

function normalizeKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The embedding service is a separate server (Render) that can be asleep, restarting or overloaded. Product
 * search doesn't need it to answer — keyword search runs alongside (lib/hybridSearch.ts) — so don't let it
 * hold a chat request hostage: give up after a few seconds (long enough for the ~4 s wake-up after idle),
 * and after a failure skip it for a short while so every request doesn't pay the full timeout.
 */
const EMBED_TIMEOUT_MS = 5_000;
const EMBED_COOLDOWN_MS = 20_000;
let embedUnavailableUntil = 0;

async function fetchEmbedding(text: string): Promise<number[]> {
  if (Date.now() < embedUnavailableUntil) {
    throw new Error("Embedding service skipped: it failed a moment ago");
  }
  try {
    return await requestEmbedding(text);
  } catch (error) {
    embedUnavailableUntil = Date.now() + EMBED_COOLDOWN_MS;
    throw error;
  }
}

async function requestEmbedding(text: string): Promise<number[]> {
  const baseUrl = process.env.EMBEDDING_API_URL || "http://127.0.0.1:5001";
  const response = await fetch(`${baseUrl}/embed`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
    cache: "no-store",
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
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
