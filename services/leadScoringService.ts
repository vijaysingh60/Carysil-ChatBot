import { getDbPool } from "@/lib/db";
import { ensureLeadSchema } from "@/services/sessionService";
import { scoreToTier, type LeadTier } from "@/types/funnel";
import type { ContactInfo, DetectedSalesIntent } from "@/types/lead";

/**
 * Behavioral lead scoring service.
 *
 * - Persists every meaningful behavioral signal to `lead_signals` with its
 *   raw weight.
 * - On read, sums the **time-decayed** weights to produce a current score,
 *   tier, and priority. Decay half-life is configurable via env
 *   `LEAD_DECAY_HALFLIFE_DAYS` (default 14).
 * - A nightly cron (`/api/cron/decay-leads`) recomputes every active session
 *   so dashboards stay fresh without per-turn writes.
 *
 * The legacy {@link calculateLeadScore} in `services/leadService.ts` remains
 * the per-turn delta for the existing `leads.lead_score` cumulative cap. This
 * service supplements it; both can coexist for one release.
 */

export const LEAD_DECAY_HALFLIFE_DAYS = Number(
  process.env.LEAD_DECAY_HALFLIFE_DAYS || 14
);

export type LeadSignalType =
  | "recommendation_click"
  | "recommendation_refinement"
  | "comparison_question"
  | "warranty_question"
  | "install_question"
  | "dealer_accept"
  | "quotation_request"
  | "repeat_visit"
  | "long_session"
  | "contact_phone"
  | "contact_email"
  | "contact_city"
  | "budget_purchase"
  | "premium_purchase"
  | "browsing";

const SIGNAL_WEIGHTS: Record<LeadSignalType, number> = {
  recommendation_click: 2,
  recommendation_refinement: 3,
  comparison_question: 3,
  warranty_question: 2,
  install_question: 2,
  dealer_accept: 6,
  quotation_request: 8,
  repeat_visit: 4,
  long_session: 3,
  contact_phone: 10,
  contact_email: 10,
  contact_city: 2,
  budget_purchase: 2,
  premium_purchase: 3,
  browsing: 0,
};

const PER_SESSION_CAPS: Partial<Record<LeadSignalType, number>> = {
  recommendation_click: 4,
  recommendation_refinement: 3,
  comparison_question: 3,
};

export type RecordSignalInput = {
  sessionId: string;
  signalType: LeadSignalType;
  weight?: number;
  source?: string;
  metadata?: Record<string, unknown>;
};

/** Persist a single behavioral signal. Respects per-session caps where defined. */
export async function recordLeadSignal(input: RecordSignalInput): Promise<void> {
  if (!(await ensureLeadSchema())) return;
  const weight = input.weight ?? SIGNAL_WEIGHTS[input.signalType] ?? 0;
  if (weight <= 0) return;
  try {
    const pool = getDbPool();
    const cap = PER_SESSION_CAPS[input.signalType];
    if (cap !== undefined) {
      const existing = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM lead_signals WHERE session_id = $1 AND signal_type = $2`,
        [input.sessionId, input.signalType]
      );
      if (Number(existing.rows[0]?.count ?? 0) >= cap) return;
    }
    await pool.query(
      `INSERT INTO lead_signals (session_id, signal_type, weight, decayed_weight, source, metadata)
       VALUES ($1, $2, $3, $3, $4, $5::jsonb)`,
      [input.sessionId, input.signalType, weight, input.source ?? null, JSON.stringify(input.metadata ?? {})]
    );
  } catch (error) {
    console.error("[scoring] recordLeadSignal failed", error);
  }
}

export type LeadScoreSnapshot = {
  score: number;
  tier: LeadTier;
  priority: number;
};

/**
 * Recompute the decayed lead score for a single session. Pure read — does not
 * write back. Use {@link applyLeadScore} to persist.
 */
export async function recomputeLeadScore(sessionId: string): Promise<LeadScoreSnapshot> {
  if (!(await ensureLeadSchema())) return { score: 0, tier: "cold", priority: 0 };
  try {
    const pool = getDbPool();
    const { rows } = await pool.query<{ total: string }>(
      `
      SELECT LEAST(100, COALESCE(SUM(
        weight * exp(-EXTRACT(EPOCH FROM (NOW() - created_at)) / ($1 * 86400))
      ), 0))::numeric(6,2)::text AS total
      FROM lead_signals WHERE session_id = $2
      `,
      [LEAD_DECAY_HALFLIFE_DAYS, sessionId]
    );
    const score = Math.round(Number(rows[0]?.total ?? 0));
    const tier = scoreToTier(score);
    const priority = await computePriority(sessionId, score);
    return { score, tier, priority };
  } catch (error) {
    console.error("[scoring] recomputeLeadScore failed", error);
    return { score: 0, tier: "cold", priority: 0 };
  }
}

async function computePriority(sessionId: string, score: number): Promise<number> {
  // Priority blends urgency, contact completeness, and high-intent flags.
  // Range is 0–1 to stay independent from the 0–100 score axis.
  try {
    const pool = getDbPool();
    const { rows } = await pool.query<{
      phone: string | null;
      email: string | null;
      city: string | null;
      name: string | null;
      quotation: string;
      dealer: string;
    }>(
      `
      SELECT
        l.phone, l.email, l.city, l.name,
        COALESCE(COUNT(*) FILTER (WHERE s.signal_type = 'quotation_request')::text, '0') AS quotation,
        COALESCE(COUNT(*) FILTER (WHERE s.signal_type = 'dealer_accept')::text, '0')     AS dealer
      FROM leads l
      LEFT JOIN lead_signals s ON s.session_id = l.session_id
      WHERE l.session_id = $1
      GROUP BY l.phone, l.email, l.city, l.name
      LIMIT 1
      `,
      [sessionId]
    );
    const row = rows[0];
    if (!row) return Number((score / 200).toFixed(3));
    let priority = 0;
    const completeness =
      (row.phone ? 0.4 : 0) + (row.email ? 0.2 : 0) + (row.city ? 0.2 : 0) + (row.name ? 0.2 : 0);
    priority += 0.3 * completeness;
    priority += 0.4 * Math.min(1, Number(row.quotation ?? 0) / 1 + Number(row.dealer ?? 0) / 2);
    priority += 0.3 * Math.min(1, score / 50);
    return Number(Math.min(1, priority).toFixed(3));
  } catch (error) {
    console.error("[scoring] computePriority failed", error);
    return Number((score / 200).toFixed(3));
  }
}

/** Apply a recomputed score back to the leads row. */
export async function applyLeadScore(
  sessionId: string,
  snapshot: LeadScoreSnapshot
): Promise<void> {
  if (!(await ensureLeadSchema())) return;
  try {
    const pool = getDbPool();
    await pool.query(
      `UPDATE leads SET lead_score = $1, lead_tier = $2, lead_priority = $3, last_decay_at = NOW() WHERE session_id = $4`,
      [snapshot.score, snapshot.tier, snapshot.priority, sessionId]
    );
  } catch (error) {
    console.error("[scoring] applyLeadScore failed", error);
  }
}

/** Convenience: record signals derived from `DetectedSalesIntent` + contact info. */
export async function recordSignalsFromTurn(input: {
  sessionId: string;
  salesIntent: DetectedSalesIntent;
  contactInfo: ContactInfo;
  message: string;
  recommendationsShown?: number;
  refinement?: boolean;
}): Promise<void> {
  const { salesIntent, contactInfo, message } = input;
  const tasks: Promise<unknown>[] = [];

  if (salesIntent.signals.includes("budget_purchase")) {
    tasks.push(recordLeadSignal({ sessionId: input.sessionId, signalType: "budget_purchase" }));
  }
  if (salesIntent.signals.includes("premium_purchase")) {
    tasks.push(recordLeadSignal({ sessionId: input.sessionId, signalType: "premium_purchase" }));
  }
  if (salesIntent.signals.includes("dealer_inquiry")) {
    tasks.push(recordLeadSignal({ sessionId: input.sessionId, signalType: "dealer_accept" }));
  }
  if (salesIntent.signals.includes("quotation_request")) {
    tasks.push(recordLeadSignal({ sessionId: input.sessionId, signalType: "quotation_request" }));
  }
  if (contactInfo.phone) tasks.push(recordLeadSignal({ sessionId: input.sessionId, signalType: "contact_phone" }));
  if (contactInfo.email) tasks.push(recordLeadSignal({ sessionId: input.sessionId, signalType: "contact_email" }));
  if (contactInfo.city) tasks.push(recordLeadSignal({ sessionId: input.sessionId, signalType: "contact_city" }));

  if (input.refinement) {
    tasks.push(recordLeadSignal({ sessionId: input.sessionId, signalType: "recommendation_refinement" }));
  }
  if (input.recommendationsShown && input.recommendationsShown > 0) {
    tasks.push(recordLeadSignal({ sessionId: input.sessionId, signalType: "recommendation_click" }));
  }
  if (/\b(warranty|guarantee)\b/i.test(message)) {
    tasks.push(recordLeadSignal({ sessionId: input.sessionId, signalType: "warranty_question" }));
  }
  if (/\binstall(ation)?\b/i.test(message) && !/\bproblem|issue|broken|leak\b/i.test(message)) {
    tasks.push(recordLeadSignal({ sessionId: input.sessionId, signalType: "install_question" }));
  }
  if (/\b(compare|vs\.?|versus|difference between)\b/i.test(message)) {
    tasks.push(recordLeadSignal({ sessionId: input.sessionId, signalType: "comparison_question" }));
  }

  await Promise.allSettled(tasks);
}

/**
 * Nightly cron entry: recompute every session updated in the last 90 days. We
 * keep the lookback bounded so the job stays small even on long-lived
 * deployments. Returns the number of sessions processed.
 */
export async function decayAllRecentLeads(lookbackDays = 90): Promise<number> {
  if (!(await ensureLeadSchema())) return 0;
  const pool = getDbPool();
  let processed = 0;
  try {
    const { rows } = await pool.query<{ session_id: string }>(
      `SELECT session_id FROM leads WHERE COALESCE(updated_at, created_at) > NOW() - ($1 * INTERVAL '1 day') LIMIT 5000`,
      [lookbackDays]
    );
    for (const row of rows) {
      const snapshot = await recomputeLeadScore(row.session_id);
      await applyLeadScore(row.session_id, snapshot);
      processed += 1;
    }
  } catch (error) {
    console.error("[scoring] decayAllRecentLeads failed", error);
  }
  return processed;
}
