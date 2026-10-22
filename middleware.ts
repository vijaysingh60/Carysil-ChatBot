import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/utils/supabase/middleware";

/** Constant-time compare, so a wrong guess doesn't reveal how many leading characters were right. */
function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * /dashboard lists customer leads (names, phone numbers, emails) and full chat transcripts, so it must not be
 * public. HTTP Basic auth: DASHBOARD_PASSWORD (required) and DASHBOARD_USER (optional, default "admin").
 *
 * It FAILS CLOSED: in production with no DASHBOARD_PASSWORD the dashboard is unavailable (503) instead of
 * open. Local development without a password stays open for convenience.
 */
function dashboardGate(request: NextRequest): NextResponse | null {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) {
    return process.env.NODE_ENV === "production"
      ? new NextResponse("Dashboard disabled: set DASHBOARD_PASSWORD (and optionally DASHBOARD_USER) to enable it.", {
          status: 503,
          headers: { "Cache-Control": "no-store" },
        })
      : null;
  }
  const user = process.env.DASHBOARD_USER || "admin";
  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    try {
      const bytes = Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0));
      const decoded = new TextDecoder().decode(bytes);
      const sep = decoded.indexOf(":");
      if (sep !== -1) {
        const userOk = safeEqual(decoded.slice(0, sep), user);
        const passOk = safeEqual(decoded.slice(sep + 1), password);
        if (userOk && passOk) return null;
      }
    } catch {
      // malformed header → fall through to the login prompt
    }
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Carysil Dashboard", charset="UTF-8"', "Cache-Control": "no-store" },
  });
}

export async function middleware(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/dashboard")) {
    const denied = dashboardGate(request);
    if (denied) return denied;
  }
  return updateSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
