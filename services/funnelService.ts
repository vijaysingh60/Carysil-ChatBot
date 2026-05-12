import { getDbPool } from "@/lib/db";
import { ensureLeadSchema } from "@/services/sessionService";
import { funnelRank, type FunnelStage } from "@/types/funnel";

/**
 * Funnel service: monotonic ratcheted advancement of `leads.funnel_stage`
 * based on signals already captured in chat_events / recommendation_events /
 * leads. The service is idempotent — repeated calls within a session
 * converge on the highest stage reached and write a `funnel_transitions`
 * row only when the stage actually changes.
 */

type SignalSnapshot = {
  recommendationsShown: number;
  recommendationClicks: number;
  dealerShown: boolean;
  dealerAccepted: boolean;
  quotationRequested: boolean;
  contactCaptured: boolean;
  hasCategory: boolean;
  hasContactComplete: boolean;
  refinements: number;
};

async function loadSignals(sessionId: string): Promise<SignalSnapshot> {
  const pool = getDbPool();
  const [chatRow, recRow, leadRow] = await Promise.all([
    pool.query<{
      shown: string;
      clicks: string;
      dealer_shown: string;
      dealer_request: string;
      quotation_request: string;
    }>(
      `
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'recommendations_shown') AS shown,
        COUNT(*) FILTER (WHERE event_type = 'cross_sell_offered')    AS clicks,
        COUNT(*) FILTER (WHERE event_type = 'dealer_results_shown')  AS dealer_shown,
        COUNT(*) FILTER (WHERE event_type = 'dealer_request')        AS dealer_request,
        COUNT(*) FILTER (WHERE event_type = 'quotation_request')     AS quotation_request
      FROM chat_events WHERE session_id = $1
      `,
      [sessionId]
    ),
    pool.query<{
      clicks: string;
      refinements: string;
      shown: string;
    }>(
      `
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'clicked')   AS clicks,
        COUNT(*) FILTER (WHERE event_type = 'refined')   AS refinements,
        COUNT(*) FILTER (WHERE event_type = 'shown')     AS shown
      FROM recommendation_events WHERE session_id = $1
      `,
      [sessionId]
    ),
    pool.query<{
      phone: string | null;
      email: string | null;
      city: string | null;
      intent: string | null;
      interested_product: string | null;
    }>(
      `SELECT phone, email, city, intent, interested_product FROM leads WHERE session_id = $1 LIMIT 1`,
      [sessionId]
    ),
  ]);

  const chat = chatRow.rows[0] ?? { shown: "0", clicks: "0", dealer_shown: "0", dealer_request: "0", quotation_request: "0" };
  const rec = recRow.rows[0] ?? { clicks: "0", refinements: "0", shown: "0" };
  const lead = leadRow.rows[0] ?? null;

  const recommendationsShown = Math.max(Number(chat.shown ?? 0), Number(rec.shown ?? 0));
  const recommendationClicks = Number(rec.clicks ?? 0);
  const refinements = Number(rec.refinements ?? 0);
  const dealerShown = Number(chat.dealer_shown ?? 0) > 0 || Number(chat.dealer_request ?? 0) > 0;
  const quotationRequested = Number(chat.quotation_request ?? 0) > 0;
  const contactCaptured = Boolean(lead?.phone || lead?.email);
  const hasCategory = Boolean(lead?.intent || lead?.interested_product);
  const hasContactComplete = Boolean(lead?.phone && lead?.city);

  return {
    recommendationsShown,
    recommendationClicks,
    refinements,
    dealerShown,
    dealerAccepted: dealerShown && contactCaptured,
    quotationRequested,
    contactCaptured,
    hasCategory,
    hasContactComplete,
  };
}

function pickStage(signals: SignalSnapshot): FunnelStage {
  if (signals.quotationRequested) return "quotation_ready";
  if (signals.dealerAccepted && signals.hasContactComplete) return "conversion_ready";
  if (signals.dealerShown) return "dealer_ready";
  if (signals.refinements > 0 || signals.recommendationClicks >= 2) return "comparison";
  if (signals.recommendationsShown >= 1) return "consideration";
  if (signals.hasCategory) return "discovery";
  return "awareness";
}

async function readCurrentStage(sessionId: string): Promise<FunnelStage | null> {
  const pool = getDbPool();
  try {
    const { rows } = await pool.query<{ funnel_stage: string | null }>(
      `SELECT funnel_stage FROM leads WHERE session_id = $1 LIMIT 1`,
      [sessionId]
    );
    const raw = rows[0]?.funnel_stage;
    return (raw as FunnelStage | null) ?? null;
  } catch {
    return null;
  }
}

export type FunnelRecomputeResult = {
  fromStage: FunnelStage | null;
  toStage: FunnelStage;
  changed: boolean;
};

/**
 * Compute the highest funnel stage justified by current signals. Only writes
 * when the new stage strictly outranks the prior stage (monotonic ratchet —
 * leads never regress).
 */
export async function recomputeFunnelStage(
  sessionId: string,
  reason?: string,
  metadata?: Record<string, unknown>
): Promise<FunnelRecomputeResult | null> {
  if (!(await ensureLeadSchema())) return null;
  try {
    const signals = await loadSignals(sessionId);
    const candidate = pickStage(signals);
    const current = await readCurrentStage(sessionId);
    if (current && funnelRank(candidate) <= funnelRank(current)) {
      return { fromStage: current, toStage: current, changed: false };
    }
    const pool = getDbPool();
    await pool.query(
      `UPDATE leads SET funnel_stage = $1, updated_at = NOW() WHERE session_id = $2`,
      [candidate, sessionId]
    );
    await pool.query(
      `INSERT INTO funnel_transitions (session_id, from_stage, to_stage, reason, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        sessionId,
        current,
        candidate,
        reason ?? null,
        JSON.stringify({ ...signals, ...(metadata ?? {}) }),
      ]
    );
    return { fromStage: current, toStage: candidate, changed: true };
  } catch (error) {
    console.error("[funnel] recomputeFunnelStage failed", error);
    return null;
  }
}

/** Manually advance a session to `converted` (used by ops dashboards/APIs). */
export async function markConverted(sessionId: string, reason = "manual_close"): Promise<void> {
  if (!(await ensureLeadSchema())) return;
  try {
    const pool = getDbPool();
    const current = await readCurrentStage(sessionId);
    if (current === "converted") return;
    await pool.query(
      `UPDATE leads SET funnel_stage = 'converted', updated_at = NOW() WHERE session_id = $1`,
      [sessionId]
    );
    await pool.query(
      `INSERT INTO funnel_transitions (session_id, from_stage, to_stage, reason)
       VALUES ($1, $2, 'converted', $3)`,
      [sessionId, current, reason]
    );
  } catch (error) {
    console.error("[funnel] markConverted failed", error);
  }
}
