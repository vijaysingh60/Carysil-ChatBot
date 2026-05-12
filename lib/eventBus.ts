/**
 * Tiny in-process event bus for analytics + chat events.
 *
 * - Batches writes within a short flush window (default 250ms) so a single
 *   concierge turn produces one or two flushes instead of N sequential inserts.
 * - Retries with jittered backoff up to MAX_RETRIES on `pg` failures.
 * - Dedupes identical payloads inside a 30s window via {@link dedupeCache}.
 * - Caller can `await flush()` when a write must be durable before the HTTP
 *   response returns (lead capture path).
 *
 * Critical writes (the `lead_captured` chat/analytics rows) must still call
 * the service functions directly with `await`. The bus is best-effort for
 * everything else.
 */

import { dedupeCache, hashKey } from "@/lib/cache";

export type EventHandler<T> = (payloads: T[]) => Promise<void>;

type Queue<T> = {
  handler: EventHandler<T>;
  pending: T[];
  flushTimer: NodeJS.Timeout | null;
  inflight: Promise<void> | null;
};

const FLUSH_WINDOW_MS = Number(process.env.EVENT_BUS_FLUSH_MS) || 250;
const MAX_RETRIES = 3;

const queues = new Map<string, Queue<unknown>>();

export type EnqueueOptions = {
  /** When provided, drops duplicate payloads sharing this key within 30s. */
  dedupeKey?: string;
  /** Skip the batching window and flush within this microtask. */
  immediate?: boolean;
};

export function registerHandler<T>(name: string, handler: EventHandler<T>): void {
  const existing = queues.get(name);
  if (existing) {
    existing.handler = handler as unknown as EventHandler<unknown>;
    return;
  }
  queues.set(name, {
    handler: handler as unknown as EventHandler<unknown>,
    pending: [],
    flushTimer: null,
    inflight: null,
  });
}

function jitter(ms: number): number {
  return ms + Math.floor(Math.random() * ms);
}

async function runWithRetries<T>(handler: EventHandler<T>, batch: T[]): Promise<void> {
  let attempt = 0;
  let lastErr: unknown = null;
  while (attempt < MAX_RETRIES) {
    try {
      await handler(batch);
      return;
    } catch (err) {
      lastErr = err;
      attempt += 1;
      if (attempt >= MAX_RETRIES) break;
      const wait = jitter(50 * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  console.error("[eventBus] giving up after retries", lastErr);
}

function scheduleFlush(name: string): void {
  const queue = queues.get(name);
  if (!queue) return;
  if (queue.flushTimer) return;
  queue.flushTimer = setTimeout(() => {
    void flushQueue(name);
  }, FLUSH_WINDOW_MS);
  // Vercel hosts can suspend the function as soon as the response resolves; we
  // make the timer non-blocking but still attempt flush. `unref` is a no-op in
  // the edge runtime — we guard for that.
  if (typeof (queue.flushTimer as { unref?: () => void }).unref === "function") {
    (queue.flushTimer as { unref?: () => void }).unref?.();
  }
}

async function flushQueue(name: string): Promise<void> {
  const queue = queues.get(name);
  if (!queue) return;
  if (queue.flushTimer) {
    clearTimeout(queue.flushTimer);
    queue.flushTimer = null;
  }
  if (queue.pending.length === 0) return;
  const batch = queue.pending.splice(0, queue.pending.length);
  const prior = queue.inflight ?? Promise.resolve();
  queue.inflight = prior.then(() => runWithRetries(queue.handler, batch));
  await queue.inflight;
}

export function enqueue<T>(name: string, payload: T, options?: EnqueueOptions): void {
  const queue = queues.get(name);
  if (!queue) {
    console.warn(`[eventBus] no handler registered for "${name}" — dropping event`);
    return;
  }
  if (options?.dedupeKey) {
    const key = `${name}:${hashKey(options.dedupeKey)}`;
    if (dedupeCache.get(key)) return;
    dedupeCache.set(key, true);
  }
  (queue.pending as T[]).push(payload);
  if (options?.immediate) {
    void flushQueue(name);
    return;
  }
  scheduleFlush(name);
}

/** Force a flush of one or all queues — call before a response that depends on writes. */
export async function flush(name?: string): Promise<void> {
  if (name) {
    await flushQueue(name);
    return;
  }
  await Promise.allSettled(Array.from(queues.keys()).map((key) => flushQueue(key)));
}

/** Convenience for tests / process shutdown. */
export function resetEventBus(): void {
  queues.forEach((queue) => {
    if (queue.flushTimer) clearTimeout(queue.flushTimer);
    queue.flushTimer = null;
    queue.pending = [];
    queue.inflight = null;
  });
}
