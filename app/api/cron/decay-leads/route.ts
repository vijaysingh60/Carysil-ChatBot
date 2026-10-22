import { NextResponse } from "next/server";
import { decayAllRecentLeads } from "@/services/leadScoringService";

/**
 * Nightly cron that recomputes time-decayed lead scores. Designed for Vercel
 * Cron + a shared secret in the `Authorization` header (CRON_SECRET). Without a secret it only runs in
 * local development; in production it refuses to run.
 *
 * Schedule example (`vercel.json`):
 *   { "crons": [{ "path": "/api/cron/decay-leads", "schedule": "0 19 * * *" }] }
 */
export const dynamic = "force-dynamic";

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  // No secret configured: open only for local development. In production this fails closed — otherwise
  // anyone could trigger the (database-heavy) recompute, and set how far back it looks via ?days=.
  if (!secret) return process.env.NODE_ENV !== "production";
  const header = request.headers.get("authorization") || "";
  return header === `Bearer ${secret}`;
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const lookbackDays = Number(url.searchParams.get("days") || "90");
  const processed = await decayAllRecentLeads(
    Number.isFinite(lookbackDays) && lookbackDays > 0 ? lookbackDays : 90
  );
  return NextResponse.json({ ok: true, processed });
}

export async function POST(request: Request): Promise<NextResponse> {
  return GET(request);
}
