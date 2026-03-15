import { NextResponse } from "next/server";

/**
 * Check if OpenAI API key is loaded. Next.js only reads .env.local (not .env.local.example).
 * Restart the dev server after creating or editing .env.local.
 */
export async function GET() {
  const key = process.env.OPENAI_API_KEY;
  const configured = Boolean(key && key.length > 0 && !key.startsWith("sk-your-"));
  return NextResponse.json({
    configured,
    message: configured
      ? "API key is set. You should see 'Live AI' when using the tools."
      : "API key missing. Create .env.local (copy from .env.local.example), add OPENAI_API_KEY=sk-..., then restart the dev server.",
  });
}
