import OpenAI from "openai";

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
