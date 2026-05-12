export const EMBEDDING_DIMENSION = 384;

type EmbedResponse = {
  embedding: number[];
};

export async function createEmbedding(text: string): Promise<number[]> {
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

export function embeddingToSqlVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
