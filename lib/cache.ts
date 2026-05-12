/**
 * Tiny per-process LRU cache with TTL.
 *
 * Designed for serverless / Vercel: every entry has a hard TTL so stale data
 * never lingers across deploys. No external dependency. Caches degrade
 * gracefully — every lookup is wrapped by the caller and a miss simply
 * triggers the original work.
 */

type Entry<V> = {
  value: V;
  expiresAt: number;
};

export type Lru<V> = {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  delete(key: string): void;
  clear(): void;
  readonly size: number;
};

export type LruOptions = {
  max: number;
  ttlMs: number;
};

export function createLru<V>(options: LruOptions): Lru<V> {
  const max = Math.max(1, options.max);
  const ttlMs = Math.max(0, options.ttlMs);
  // Map preserves insertion order — we re-insert on hit to move to "newest".
  const store = new Map<string, Entry<V>>();

  function evictIfNeeded(): void {
    while (store.size > max) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) return;
      store.delete(oldest);
    }
  }

  return {
    get(key: string): V | undefined {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        return undefined;
      }
      // Re-insert to move to "most recently used" position.
      store.delete(key);
      store.set(key, entry);
      return entry.value;
    },
    set(key: string, value: V): void {
      const expiresAt = ttlMs === 0 ? Number.POSITIVE_INFINITY : Date.now() + ttlMs;
      if (store.has(key)) store.delete(key);
      store.set(key, { value, expiresAt });
      evictIfNeeded();
    },
    delete(key: string): void {
      store.delete(key);
    },
    clear(): void {
      store.clear();
    },
    get size(): number {
      return store.size;
    },
  };
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 10-minute embedding cache. Embedding calls are the hottest dependency. */
export const embeddingCache = createLru<number[]>({
  max: envInt("LRU_MAX_EMBEDDINGS", 500),
  ttlMs: envInt("LRU_TTL_EMBEDDINGS_MS", 10 * 60_000),
});

/** 60-second retrieval cache keyed by query + filter signature. */
export const retrievalCache = createLru<unknown>({
  max: envInt("LRU_MAX_RETRIEVAL", 200),
  ttlMs: envInt("LRU_TTL_RETRIEVAL_MS", 60_000),
});

/** 5-minute LLM JSON cache for recommendation/follow-up calls. */
export const llmJsonCache = createLru<unknown>({
  max: envInt("LRU_MAX_LLM_JSON", 200),
  ttlMs: envInt("LRU_TTL_LLM_JSON_MS", 5 * 60_000),
});

/** 30-second dedupe of identical chat/analytics writes. */
export const dedupeCache = createLru<true>({
  max: envInt("LRU_MAX_DEDUPE", 1000),
  ttlMs: envInt("LRU_TTL_DEDUPE_MS", 30_000),
});

/** Stable-ish hash for short strings (FNV-1a). Good enough for cache keys. */
export function hashKey(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}
