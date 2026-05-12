import OpenAI from "openai";
import { hashKey, llmJsonCache } from "@/lib/cache";

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

export type AIResult = {
  text: string;
  aiUsed: boolean;
  /** Set when API key is present but the request failed (e.g. quota) */
  error?: "quota_exceeded" | "api_error";
};

export async function callAI(
  systemPrompt: string,
  userContent: string,
  placeholderResponse: string
): Promise<AIResult> {
  if (!openai) {
    return { text: placeholderResponse, aiUsed: false };
  }
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      max_tokens: 2048,
    });
    const text = completion.choices[0]?.message?.content?.trim();
    return {
      text: text || placeholderResponse,
      aiUsed: true,
    };
  } catch (err: unknown) {
    const is429 =
      err &&
      typeof err === "object" &&
      "status" in err &&
      (err as { status?: number }).status === 429;
    const isQuota =
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "insufficient_quota";
    const errorType =
      is429 || isQuota ? "quota_exceeded" : "api_error";
    console.error("[AI] API call failed:", err);
    return {
      text: placeholderResponse,
      aiUsed: false,
      error: errorType,
    };
  }
}

/**
 * Structured JSON completion (gpt-4o-mini). Falls back to `fallback` when no key, parse error, or API failure.
 */
export async function callAIJson<T extends Record<string, unknown>>(
  systemPrompt: string,
  userContent: string,
  fallback: T
): Promise<{ data: T; aiUsed: boolean; error?: AIResult["error"] }> {
  if (!openai) {
    return { data: fallback, aiUsed: false };
  }
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
      max_tokens: 900,
    });
    const text = completion.choices[0]?.message?.content?.trim();
    if (!text) {
      return { data: fallback, aiUsed: true };
    }
    const parsed = JSON.parse(text) as Partial<T>;
    return { data: { ...fallback, ...parsed } as T, aiUsed: true };
  } catch (err: unknown) {
    const is429 =
      err &&
      typeof err === "object" &&
      "status" in err &&
      (err as { status?: number }).status === 429;
    const isQuota =
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "insufficient_quota";
    const errorType = is429 || isQuota ? "quota_exceeded" : "api_error";
    console.error("[AI] JSON API call failed:", err);
    return {
      data: fallback,
      aiUsed: false,
      error: errorType,
    };
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
