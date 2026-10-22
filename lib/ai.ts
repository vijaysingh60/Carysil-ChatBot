import Anthropic from "@anthropic-ai/sdk";
import { hashKey, llmJsonCache } from "@/lib/cache";

// The SDK's defaults are a 10-minute timeout and 2 retries — a single stalled connection would hold a chat
// request for minutes. Haiku answers in 1-5 s, so a call that isn't back in 12 s is better replaced by the
// fallback text than awaited.
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 12_000, maxRetries: 1 })
  : null;

/**
 * A chat turn makes several AI calls in a row. If Claude's API has just timed out or errored (connection
 * trouble, 5xx/overloaded), every remaining call in the turn would wait out its own timeout too — so skip
 * Claude briefly and let the fallback answers (keyword search, canned wording) serve the turn right away.
 * Quota/auth/bad-request errors don't trip this: those fail instantly anyway.
 */
const AI_COOLDOWN_MS = 15_000;
let aiUnavailableUntil = 0;
function noteAiFailure(err: unknown): void {
  if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.InternalServerError) {
    aiUnavailableUntil = Date.now() + AI_COOLDOWN_MS;
  }
}
const aiCoolingDown = () => Date.now() < aiUnavailableUntil;

export const MODEL = "claude-haiku-5-5";

export type AIResult = {
  text: string;
  aiUsed: boolean;
  /** Set when API key is present but the request failed (e.g. quota) */
  error?: "quota_exceeded" | "api_error";
};

/** First text block's content, or "" if the model returned none (e.g. tool-only/refusal). */
function textFromResponse(message: Anthropic.Message): string {
  const block = message.content.find((b) => b.type === "text");
  return block?.type === "text" ? block.text.trim() : "";
}

/**
 * Anthropic has no single discriminated "insufficient_quota" field like
 * OpenAI's — a 429 is the closest signal, plus a credit-balance message on
 * some 400s. Same two-bucket contract as before: anything else is "api_error".
 */
function classifyError(err: unknown): "quota_exceeded" | "api_error" {
  if (err instanceof Anthropic.RateLimitError) return "quota_exceeded";
  if (err instanceof Anthropic.APIError && /credit balance/i.test(err.message)) {
    return "quota_exceeded";
  }
  return "api_error";
}

export async function callAI(
  systemPrompt: string,
  userContent: string,
  placeholderResponse: string
): Promise<AIResult> {
  if (!anthropic) {
    return { text: placeholderResponse, aiUsed: false };
  }
  if (aiCoolingDown()) {
    return { text: placeholderResponse, aiUsed: false, error: "api_error" };
  }
  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    });
    const text = textFromResponse(message);
    return {
      text: text || placeholderResponse,
      aiUsed: true,
    };
  } catch (err: unknown) {
    noteAiFailure(err);
    const errorType = classifyError(err);
    console.error("[AI] API call failed:", err);
    return {
      text: placeholderResponse,
      aiUsed: false,
      error: errorType,
    };
  }
}

/**
 * Structured JSON completion (claude-haiku-5-5). Falls back to `fallback` when no key, parse error, or API failure.
 * Relies on the system/user prompt asking for JSON-only output (same contract
 * as before) rather than a schema-validated format — callers already merge
 * the parsed result onto `fallback`, so a malformed reply degrades safely.
 */
export async function callAIJson<T extends Record<string, unknown>>(
  systemPrompt: string,
  userContent: string,
  fallback: T
): Promise<{ data: T; aiUsed: boolean; error?: AIResult["error"] }> {
  if (!anthropic) {
    return { data: fallback, aiUsed: false };
  }
  if (aiCoolingDown()) {
    return { data: fallback, aiUsed: false, error: "api_error" };
  }
  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 900,
      system: `${systemPrompt}\n\nRespond with a single valid JSON object only — no markdown, no code fences, no commentary.`,
      messages: [{ role: "user", content: userContent }],
    });
    const text = textFromResponse(message);
    if (!text) {
      return { data: fallback, aiUsed: true };
    }
    const parsed = parseJsonLoose<Partial<T>>(text);
    if (!parsed) throw new Error("Model reply contained no JSON object");
    return { data: { ...fallback, ...parsed } as T, aiUsed: true };
  } catch (err: unknown) {
    noteAiFailure(err);
    const errorType = classifyError(err);
    console.error("[AI] JSON API call failed:", err);
    return {
      data: fallback,
      aiUsed: false,
      error: errorType,
    };
  }
}

/**
 * Reads a JSON object out of a model reply, tolerating the usual wrappers: a ```json fence, or a sentence
 * before/after the object ("Here is the JSON: {...}"). Returns null if there is no parseable object.
 */
export function parseJsonLoose<T = Record<string, unknown>>(text: string): T | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate) as T;
  } catch {
    const first = candidate.indexOf("{");
    const last = candidate.lastIndexOf("}");
    if (first === -1 || last <= first) return null;
    try {
      return JSON.parse(candidate.slice(first, last + 1)) as T;
    } catch {
      return null;
    }
  }
}

/**
 * 5-minute in-memory memoization of identical JSON LLM calls. Used by the
 * recommendation/follow-up planner where the same compact prompt is rebuilt
 * within a session. Cache misses fall through to {@link callAIJson}.
 */
export async function callAIJsonCached<T extends Record<string, unknown>>(
  systemPrompt: string,
  userContent: string,
  fallback: T,
  cacheKey?: string
): Promise<{ data: T; aiUsed: boolean; error?: AIResult["error"]; cached?: boolean }> {
  const key = hashKey(`${cacheKey ?? ""}|${systemPrompt}|${userContent}`);
  const hit = llmJsonCache.get(key) as
    | { data: T; aiUsed: boolean; error?: AIResult["error"] }
    | undefined;
  if (hit) return { ...hit, cached: true };

  const result = await callAIJson(systemPrompt, userContent, fallback);
  if (result.aiUsed && !result.error) {
    llmJsonCache.set(key, result);
  }
  return result;
}
