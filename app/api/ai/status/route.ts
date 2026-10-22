import { NextResponse } from "next/server";

/**
 * Check if the Claude API key is loaded (lib/ai.ts reads ANTHROPIC_API_KEY). Next.js only reads
 * .env.local (not .env.local.example). Restart the dev server after creating or editing .env.local.
 */
/**
 * Bump when shipping a behaviour change, so `curl <site>/api/ai/status` shows which build is actually live.
 * (Added when a deploy of the catalogue-search fixes was suspected not to have gone out.)
 */
const BUILD = "2026-10-22-catalog-search-fixes";

export const dynamic = "force-dynamic";

export async function GET() {
  const key = process.env.ANTHROPIC_API_KEY;
  const configured = Boolean(key && key.length > 0 && !key.startsWith("sk-ant-your-"));
  return NextResponse.json({
    build: BUILD,
    configured,
    message: configured
      ? "API key is set. You should see 'Live AI' when using the tools."
      : "API key missing. Create .env.local (copy from .env.local.example), add ANTHROPIC_API_KEY=sk-ant-..., then restart the dev server.",
  });
}
