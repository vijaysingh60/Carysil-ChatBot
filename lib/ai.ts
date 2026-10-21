import Anthropic from "@anthropic-ai/sdk";
import { hashKey, llmJsonCache } from "@/lib/cache";

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const MODEL = "claude-haiku-5-5";

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
    const parsed = JSON.parse(stripJsonFence(text)) as Partial<T>;
    return { data: { ...fallback, ...parsed } as T, aiUsed: true };
  } catch (err: unknown) {
    const errorType = classifyError(err);
    console.error("[AI] JSON API call failed:", err);
    return {
      data: fallback,
      aiUsed: false,
      error: errorType,
    };
  }
}

/** Strips a ```json ... ``` / ``` ... ``` fence if the model wrapped its JSON in one despite the instruction not to. */
function stripJsonFence(text: string): string {
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : text;
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
