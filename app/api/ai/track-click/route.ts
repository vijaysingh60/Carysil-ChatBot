import { NextResponse } from "next/server";
import { logClick } from "@/services/recommendationAnalyticsService";
import { flush } from "@/lib/eventBus";

/**
 * Lightweight click tracker fired by the chat widget when a recommendation
 * link is opened. Designed to work with `navigator.sendBeacon` so the request
 * still completes even after the user has navigated away.
 */
export async function POST(request: Request) {
  try {
    let body: { sessionId?: string; productId?: string; meta?: Record<string, unknown> } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      // sendBeacon delivers as Blob with text/plain; try to parse manually.
      const raw = await request.text();
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        body = {};
      }
    }
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const productId = typeof body.productId === "string" ? body.productId.trim() : "";
    if (!sessionId || !productId) {
      return NextResponse.json({ ok: false, error: "Missing sessionId or productId" }, { status: 400 });
    }
    logClick(sessionId, productId, body.meta && typeof body.meta === "object" ? body.meta : undefined);
    // sendBeacon doesn't wait, but a flush keeps the unit-test path durable.
    void flush("recommendation_event");
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[track-click] failed", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
