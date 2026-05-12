import { getDbPool } from "@/lib/db";
import { formatDashboardDate } from "@/lib/dashboardFormat";
import { ensureLeadSchema } from "@/services/sessionService";
import { LeadsBlock } from "./LeadsBlock";
import { ShowMoreList } from "./ShowMore";
import { LeadQualityChart, type LeadQualityPoint } from "./_components/LeadQualityChart";
import { FunnelChart, type FunnelStagePoint } from "./_components/FunnelChart";
import { SimpleBarChart, type SimpleBarPoint } from "./_components/SimpleBarChart";
import { Heatmap, type HeatmapCell } from "./_components/Heatmap";
import { RangeSelector } from "./_components/RangeSelector";
import { FUNNEL_STAGES } from "@/types/funnel";

export const dynamic = "force-dynamic";

type MetricRow = {
  label: string | null;
  count: string;
};

type InterestedProductRow = {
  id?: string;
  name?: string;
  category?: string;
  shown_at?: string;
};

type LeadRow = {
  session_id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  intent: string | null;
  interested_product: string | null;
  interested_products: InterestedProductRow[] | null;
  followup_stage: string | null;
  lead_score: number;
  created_at: Date;
  updated_at: Date | null;
};

type AnalyticsRow = {
  query: string;
  detected_intent: string | null;
  category: string | null;
  budget_type: string | null;
  city: string | null;
  created_at: Date;
};

type EventRow = {
  session_id: string;
  role: string;
  event_type: string;
  message: string;
  metadata: Record<string, unknown>;
  created_at: Date;
};

type DashboardData = {
  range: string;
  rangeDays: number | null;
  totals: {
    sessions: number;
    leads: number;
    analyticsEvents: number;
    chatEvents: number;
    hotLeads: number;
    followupsAsked: number;
    leadsCaptured: number;
    dealerRequests: number;
    returningVisitors: number;
    convertedLeads: number;
  };
  categoryCounts: MetricRow[];
  intentCounts: MetricRow[];
  cityCounts: MetricRow[];
  followupStageCounts: MetricRow[];
  recentLeads: LeadRow[];
  recentAnalytics: AnalyticsRow[];
  recentEvents: EventRow[];
  leadQualityTimeseries: LeadQualityPoint[];
  funnelDistribution: FunnelStagePoint[];
  bestConvertingProducts: SimpleBarPoint[];
  ignoredProducts: SimpleBarPoint[];
  demandHeatmap: { rows: string[]; cols: string[]; cells: HeatmapCell[] };
  dropOffHistogram: SimpleBarPoint[];
  followupEffectiveness: SimpleBarPoint[];
  retrievalSuccess: { ctrPct: number; avgSimilarity: number | null; impressions: number };
};

const VALID_RANGES = new Set(["7d", "30d", "90d", "all"]);

function parseRange(value: string | undefined): { range: string; days: number | null } {
  const safe = value && VALID_RANGES.has(value) ? value : "30d";
  if (safe === "all") return { range: "all", days: null };
  const days = Number(safe.replace("d", ""));
  return { range: safe, days: Number.isFinite(days) && days > 0 ? days : 30 };
}

function rangeClause(days: number | null, column = "created_at"): { clause: string; params: unknown[] } {
  if (days === null) return { clause: "", params: [] };
  return { clause: `${column} > NOW() - ($1 * INTERVAL '1 day')`, params: [days] };
}

function toNumber(value: unknown): number {
  return Number(value || 0);
}

function compactText(value: string | null | undefined, fallback = "Not captured"): string {
  if (!value) return fallback;
  return value.length > 140 ? `${value.slice(0, 140)}...` : value;
}

async function getDashboardData(searchRange: string | undefined): Promise<DashboardData> {
  await ensureLeadSchema();
  const pool = getDbPool();
  const { range, days } = parseRange(searchRange);

  const analytics = rangeClause(days, "created_at");
  const leadsRange = rangeClause(days, "COALESCE(updated_at, created_at)");
  const eventsRange = rangeClause(days, "created_at");

  const totalsSql = `
    SELECT
      (SELECT COUNT(*) FROM chat_sessions ${days ? `WHERE started_at > NOW() - ($1 * INTERVAL '1 day')` : ""}) AS sessions,
      (SELECT COUNT(*) FROM leads ${leadsRange.clause ? `WHERE ${leadsRange.clause}` : ""}) AS leads,
      (SELECT COUNT(*) FROM analytics_events ${analytics.clause ? `WHERE ${analytics.clause}` : ""}) AS analytics_events,
      (SELECT COUNT(*) FROM chat_events ${eventsRange.clause ? `WHERE ${eventsRange.clause}` : ""}) AS chat_events,
      (SELECT COUNT(*) FROM leads WHERE lead_tier IN ('hot','high_intent') ${leadsRange.clause ? `AND ${leadsRange.clause}` : ""}) AS hot_leads,
      (SELECT COUNT(*) FROM chat_events WHERE event_type IN ('followup_question_asked', 'cross_sell_offered') ${eventsRange.clause ? `AND ${eventsRange.clause}` : ""}) AS followups_asked,
      (SELECT COUNT(*) FROM chat_events WHERE event_type = 'lead_captured' ${eventsRange.clause ? `AND ${eventsRange.clause}` : ""}) AS leads_captured,
      (SELECT COUNT(*) FROM chat_events WHERE event_type IN ('dealer_results_shown', 'dealer_request') ${eventsRange.clause ? `AND ${eventsRange.clause}` : ""}) AS dealer_requests,
      (SELECT COUNT(*) FROM visitors WHERE sessions_count > 1) AS returning_visitors,
      (SELECT COUNT(*) FROM leads WHERE funnel_stage = 'converted' ${leadsRange.clause ? `AND ${leadsRange.clause}` : ""}) AS converted_leads
  `;

  const totalsParams = days ? [days] : [];

  const [
    totalsResult,
    categoryResult,
    intentResult,
    cityResult,
    followupStageResult,
    leadsResult,
    analyticsResult,
    eventsResult,
    leadQualityResult,
    funnelResult,
    bestProductsResult,
    ignoredProductsResult,
    heatmapResult,
    dropOffResult,
    followupEffectivenessResult,
    retrievalSuccessResult,
  ] = await Promise.all([
    pool.query<{
      sessions: string;
      leads: string;
      analytics_events: string;
      chat_events: string;
      hot_leads: string;
      followups_asked: string;
      leads_captured: string;
      dealer_requests: string;
      returning_visitors: string;
      converted_leads: string;
    }>(totalsSql, totalsParams),
    pool.query<MetricRow>(
      `SELECT COALESCE(category, 'Unknown') AS label, COUNT(*) AS count
       FROM analytics_events ${analytics.clause ? `WHERE ${analytics.clause}` : ""}
       GROUP BY COALESCE(category, 'Unknown') ORDER BY COUNT(*) DESC LIMIT 8`,
      analytics.params
    ),
    pool.query<MetricRow>(
      `SELECT COALESCE(detected_intent, 'Unknown') AS label, COUNT(*) AS count
       FROM analytics_events ${analytics.clause ? `WHERE ${analytics.clause}` : ""}
       GROUP BY COALESCE(detected_intent, 'Unknown') ORDER BY COUNT(*) DESC LIMIT 8`,
      analytics.params
    ),
    pool.query<MetricRow>(
      `SELECT COALESCE(city, 'Unknown') AS label, COUNT(*) AS count
       FROM analytics_events ${analytics.clause ? `WHERE ${analytics.clause}` : ""}
       GROUP BY COALESCE(city, 'Unknown') ORDER BY COUNT(*) DESC LIMIT 8`,
      analytics.params
    ),
    pool.query<MetricRow>(
      `SELECT COALESCE(followup_stage, 'browsing') AS label, COUNT(*) AS count
       FROM leads ${leadsRange.clause ? `WHERE ${leadsRange.clause}` : ""}
       GROUP BY COALESCE(followup_stage, 'browsing') ORDER BY COUNT(*) DESC LIMIT 8`,
      leadsRange.params
    ),
    pool.query<LeadRow>(
      `SELECT session_id, name, phone, email, city, intent, interested_product,
              interested_products, followup_stage, lead_score, created_at, updated_at
       FROM leads ${leadsRange.clause ? `WHERE ${leadsRange.clause}` : ""}
       ORDER BY lead_priority DESC, lead_score DESC, COALESCE(updated_at, created_at) DESC LIMIT 20`,
      leadsRange.params
    ),
    pool.query<AnalyticsRow>(
      `SELECT query, detected_intent, category, budget_type, city, created_at
       FROM analytics_events ${analytics.clause ? `WHERE ${analytics.clause}` : ""}
       ORDER BY created_at DESC LIMIT 30`,
      analytics.params
    ),
    pool.query<EventRow>(
      `SELECT session_id, role, event_type, message, metadata, created_at
       FROM chat_events ${eventsRange.clause ? `WHERE ${eventsRange.clause}` : ""}
       ORDER BY created_at DESC LIMIT 30`,
      eventsRange.params
    ),
    pool.query<{ day: string; cold: string; warm: string; hot: string; high_intent: string }>(
      `SELECT
         to_char(DATE_TRUNC('day', COALESCE(updated_at, created_at)), 'MM-DD') AS day,
         COUNT(*) FILTER (WHERE lead_tier = 'cold')        AS cold,
         COUNT(*) FILTER (WHERE lead_tier = 'warm')        AS warm,
         COUNT(*) FILTER (WHERE lead_tier = 'hot')         AS hot,
         COUNT(*) FILTER (WHERE lead_tier = 'high_intent') AS high_intent
       FROM leads ${leadsRange.clause ? `WHERE ${leadsRange.clause}` : ""}
       GROUP BY DATE_TRUNC('day', COALESCE(updated_at, created_at))
       ORDER BY DATE_TRUNC('day', COALESCE(updated_at, created_at)) ASC`,
      leadsRange.params
    ),
    pool.query<{ funnel_stage: string; sessions: string }>(
      `SELECT funnel_stage, COUNT(*)::text AS sessions
       FROM leads ${leadsRange.clause ? `WHERE ${leadsRange.clause}` : ""}
       GROUP BY funnel_stage`,
      leadsRange.params
    ),
    pool.query<{ product_id: string; conversions: string; clicks: string; impressions: string }>(
      `SELECT product_id, conversions::text, clicks::text, impressions::text
       FROM v_best_converting_products LIMIT 8`
    ),
    pool.query<{ product_id: string; retrievals: string }>(
      `SELECT product_id, retrievals::text FROM v_ignored_products LIMIT 8`
    ),
    pool.query<{ category: string | null; city: string | null; n: string }>(
      `SELECT COALESCE(category, 'Unknown') AS category, COALESCE(city, 'Unknown') AS city, COUNT(*) AS n
       FROM analytics_events
       ${analytics.clause ? `WHERE ${analytics.clause}` : ""}
       GROUP BY COALESCE(category, 'Unknown'), COALESCE(city, 'Unknown')
       ORDER BY COUNT(*) DESC
       LIMIT 60`,
      analytics.params
    ),
    pool.query<{ bucket: string; n: string }>(
      `WITH counts AS (
         SELECT session_id, COUNT(*) FILTER (WHERE role = 'user') AS user_turns
         FROM chat_events
         ${eventsRange.clause ? `WHERE ${eventsRange.clause}` : ""}
         GROUP BY session_id
       )
       SELECT
         CASE
           WHEN user_turns = 1 THEN '1'
           WHEN user_turns BETWEEN 2 AND 3 THEN '2-3'
           WHEN user_turns BETWEEN 4 AND 6 THEN '4-6'
           WHEN user_turns BETWEEN 7 AND 10 THEN '7-10'
           ELSE '11+'
         END AS bucket,
         COUNT(*)::text AS n
       FROM counts
       GROUP BY bucket
       ORDER BY MIN(user_turns)`,
      eventsRange.params
    ),
    pool.query<{ reason: string; total: string; converted: string }>(
      `SELECT
         COALESCE(metadata->>'followup_reason', 'none') AS reason,
         COUNT(*)::text AS total,
         COUNT(*) FILTER (
           WHERE session_id IN (SELECT session_id FROM leads WHERE phone IS NOT NULL OR email IS NOT NULL)
         )::text AS converted
       FROM chat_events
       WHERE event_type IN ('followup_question_asked', 'lead_prompted', 'cross_sell_offered')
       ${eventsRange.clause ? `AND ${eventsRange.clause}` : ""}
       GROUP BY COALESCE(metadata->>'followup_reason', 'none')
       ORDER BY COUNT(*) DESC
       LIMIT 10`,
      eventsRange.params
    ),
    pool.query<{ impressions: string; clicked_sessions: string; avg_similarity: string | null }>(
      `SELECT
         COUNT(*) FILTER (WHERE event_type = 'shown')::text AS impressions,
         COUNT(DISTINCT session_id) FILTER (
           WHERE event_type = 'clicked'
         )::text AS clicked_sessions,
         AVG(similarity) FILTER (WHERE event_type = 'clicked')::text AS avg_similarity
       FROM recommendation_events
       ${analytics.clause ? `WHERE ${analytics.clause}` : ""}`,
      analytics.params
    ),
  ]);

  const totals = totalsResult.rows[0];

  const leadQualityTimeseries: LeadQualityPoint[] = leadQualityResult.rows.map((row) => ({
    day: row.day,
    cold: Number(row.cold ?? 0),
    warm: Number(row.warm ?? 0),
    hot: Number(row.hot ?? 0),
    high_intent: Number(row.high_intent ?? 0),
  }));

  // Build funnel sessions in canonical stage order with drop-off vs prior stage.
  const stageMap = new Map<string, number>();
  for (const row of funnelResult.rows) stageMap.set(row.funnel_stage, Number(row.sessions ?? 0));
  const funnelDistribution: FunnelStagePoint[] = FUNNEL_STAGES.map((stage, index, arr) => {
    const sessions = stageMap.get(stage) ?? 0;
    let dropOffPct: number | undefined;
    if (index > 0) {
      const prev = stageMap.get(arr[index - 1]) ?? 0;
      if (prev > 0) {
        dropOffPct = ((prev - sessions) / prev) * 100;
      }
    }
    return { stage, sessions, dropOffPct };
  });

  const bestConvertingProducts: SimpleBarPoint[] = bestProductsResult.rows.map((row) => ({
    label: row.product_id,
    value: Number(row.conversions ?? 0) || Number(row.clicks ?? 0) || Number(row.impressions ?? 0),
  }));
  const ignoredProducts: SimpleBarPoint[] = ignoredProductsResult.rows.map((row) => ({
    label: row.product_id,
    value: Number(row.retrievals ?? 0),
  }));

  const topRows = new Set<string>();
  const topCols = new Set<string>();
  const heatmapCells: HeatmapCell[] = [];
  for (const row of heatmapResult.rows) {
    const r = row.category ?? "Unknown";
    const c = row.city ?? "Unknown";
    topRows.add(r);
    topCols.add(c);
    heatmapCells.push({ row: r, col: c, value: Number(row.n ?? 0) });
  }

  const dropOffHistogram: SimpleBarPoint[] = dropOffResult.rows.map((row) => ({
    label: row.bucket,
    value: Number(row.n ?? 0),
  }));

  const followupEffectiveness: SimpleBarPoint[] = followupEffectivenessResult.rows.map((row) => {
    const total = Number(row.total ?? 0);
    const converted = Number(row.converted ?? 0);
    const pct = total > 0 ? Math.round((converted / total) * 1000) / 10 : 0;
    return { label: row.reason || "none", value: pct };
  });

  const retrievalRow = retrievalSuccessResult.rows[0];
  const impressions = Number(retrievalRow?.impressions ?? 0);
  const clickedSessions = Number(retrievalRow?.clicked_sessions ?? 0);
  const avgSimilarityRaw = retrievalRow?.avg_similarity;
  const avgSimilarity = avgSimilarityRaw ? Number(Number(avgSimilarityRaw).toFixed(3)) : null;
  const ctrPct = impressions > 0 ? Math.round((clickedSessions / impressions) * 1000) / 10 : 0;

  return {
    range,
    rangeDays: days,
    totals: {
      sessions: toNumber(totals.sessions),
      leads: toNumber(totals.leads),
      analyticsEvents: toNumber(totals.analytics_events),
      chatEvents: toNumber(totals.chat_events),
      hotLeads: toNumber(totals.hot_leads),
      followupsAsked: toNumber(totals.followups_asked),
      leadsCaptured: toNumber(totals.leads_captured),
      dealerRequests: toNumber(totals.dealer_requests),
      returningVisitors: toNumber(totals.returning_visitors),
      convertedLeads: toNumber(totals.converted_leads),
    },
    categoryCounts: categoryResult.rows,
    intentCounts: intentResult.rows,
    cityCounts: cityResult.rows,
    followupStageCounts: followupStageResult.rows,
    recentLeads: leadsResult.rows,
    recentAnalytics: analyticsResult.rows,
    recentEvents: eventsResult.rows,
    leadQualityTimeseries,
    funnelDistribution,
    bestConvertingProducts,
    ignoredProducts,
    demandHeatmap: {
      rows: Array.from(topRows).slice(0, 8),
      cols: Array.from(topCols).slice(0, 8),
      cells: heatmapCells,
    },
    dropOffHistogram,
    followupEffectiveness,
    retrievalSuccess: { ctrPct, avgSimilarity, impressions },
  };
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
      <p className="text-xs font-medium text-gray-500 sm:text-sm">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold text-carysil-stone sm:mt-2 sm:text-3xl">{value}</p>
    </div>
  );
}

function MiniBarList({ title, rows }: { title: string; rows: MetricRow[] }) {
  const max = Math.max(...rows.map((row) => toNumber(row.count)), 1);

  return (
    <section className="min-w-0 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
      <h2 className="text-base font-semibold text-carysil-stone sm:text-lg">{title}</h2>
      <div className="mt-3 space-y-2.5 sm:mt-4 sm:space-y-3">
        {rows.length === 0 ? (
          <p className="text-sm text-gray-500">No data yet.</p>
        ) : (
          rows.map((row) => {
            const count = toNumber(row.count);
            return (
              <div key={row.label || "Unknown"}>
                <div className="mb-1 flex items-center justify-between gap-2 text-xs sm:gap-3 sm:text-sm">
                  <span className="truncate text-gray-700">{row.label || "Unknown"}</span>
                  <span className="font-medium text-carysil-stone">{count}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-gray-100">
                  <div
                    className="h-full rounded-full bg-[var(--carysil-red)]"
                    style={{ width: `${Math.max((count / max) * 100, 8)}%` }}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-w-0 max-w-full rounded-xl border border-dashed border-gray-300 bg-gray-50 p-6 text-sm text-gray-500 break-words">
      {children}
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-carysil-stone sm:text-lg">{title}</h2>
        {subtitle ? <p className="text-xs text-gray-500">{subtitle}</p> : null}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: { range?: string };
}) {
  let data: DashboardData | null = null;
  let error: string | null = null;

  try {
    data = await getDashboardData(searchParams?.range);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Unable to load dashboard data.";
  }

  if (error || !data) {
    return (
      <div className="min-w-0 space-y-6">
        <section className="rounded-2xl border border-red-200 bg-red-50 p-6">
          <p className="text-sm font-medium uppercase tracking-widest text-red-700">Dashboard unavailable</p>
          <h1 className="mt-2 text-3xl font-semibold text-carysil-stone">Could not load analytics</h1>
          <p className="mt-3 text-gray-700">
            Check that `DATABASE_URL` is set in `.env.local` and Postgres is running.
          </p>
          <p className="mt-3 rounded-lg bg-white p-3 text-sm text-red-700">{error}</p>
        </section>
      </div>
    );
  }

  return (
    <div className="min-w-0 max-w-full space-y-8">
      <section className="min-w-0 max-w-full overflow-hidden rounded-2xl bg-[var(--carysil-stone)] p-6 text-white sm:p-8">
        <p className="text-sm font-medium uppercase tracking-widest text-[var(--carysil-red)]">
          AskCary dashboard
        </p>
        <div className="mt-3 flex min-w-0 flex-wrap items-end justify-between gap-4">
          <div className="min-w-0 max-w-full">
            <h1 className="text-3xl font-semibold sm:text-4xl">Leads and analytics</h1>
            <p className="mt-2 max-w-2xl break-words text-gray-300">
              Live view of chat sessions, captured leads, product intent, recommendation
              performance, and funnel intelligence.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <RangeSelector active={data.range} />
            <p className="text-sm text-gray-400">Refresh the page to see latest data.</p>
          </div>
        </div>
      </section>

      <section className="grid min-w-0 grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
        <MetricCard label="Sessions" value={data.totals.sessions} />
        <MetricCard label="Leads" value={data.totals.leads} />
        <MetricCard label="Hot Leads" value={data.totals.hotLeads} />
        <MetricCard label="Leads Captured" value={data.totals.leadsCaptured} />
        <MetricCard label="Converted" value={data.totals.convertedLeads} />
        <MetricCard label="Returning Visitors" value={data.totals.returningVisitors} />
        <MetricCard label="Follow-ups Asked" value={data.totals.followupsAsked} />
        <MetricCard label="Dealer Requests" value={data.totals.dealerRequests} />
        <MetricCard label="Analytics Events" value={data.totals.analyticsEvents} />
        <MetricCard label="Chat Events" value={data.totals.chatEvents} />
      </section>

      <section className="grid min-w-0 gap-6 lg:grid-cols-2">
        <ChartCard title="Lead quality over time" subtitle="cold / warm / hot / high_intent">
          <LeadQualityChart data={data.leadQualityTimeseries} />
        </ChartCard>
        <ChartCard title="Funnel conversion" subtitle="sessions per stage with drop-off">
          <FunnelChart data={data.funnelDistribution} />
        </ChartCard>
      </section>

      <section className="grid min-w-0 gap-6 lg:grid-cols-2">
        <ChartCard title="Recommendation performance" subtitle="conversions / clicks (top 8)">
          <SimpleBarChart data={data.bestConvertingProducts} color="#dc2626" emptyText="No recommendation activity yet." />
        </ChartCard>
        <ChartCard title="Ignored products" subtitle="retrieved but never shown or clicked">
          <SimpleBarChart data={data.ignoredProducts} color="#9ca3af" emptyText="No ignored products in range." />
        </ChartCard>
      </section>

      <section className="grid min-w-0 gap-6 lg:grid-cols-2">
        <ChartCard title="Product demand heatmap" subtitle="category × city">
          <Heatmap rows={data.demandHeatmap.rows} cols={data.demandHeatmap.cols} cells={data.demandHeatmap.cells} />
        </ChartCard>
        <ChartCard title="Conversation drop-off" subtitle="user turns per session">
          <SimpleBarChart data={data.dropOffHistogram} color="#7f1d1d" />
        </ChartCard>
      </section>

      <section className="grid min-w-0 gap-6 lg:grid-cols-2">
        <ChartCard title="AI follow-up effectiveness" subtitle="conversion rate (%) per follow-up reason">
          <SimpleBarChart data={data.followupEffectiveness} color="#0ea5e9" />
        </ChartCard>
        <ChartCard
          title="Retrieval success"
          subtitle={`${data.retrievalSuccess.impressions} impressions${data.retrievalSuccess.avgSimilarity !== null ? `, avg similarity @ click ${data.retrievalSuccess.avgSimilarity}` : ""}`}
        >
          <div className="flex h-64 flex-col items-center justify-center text-center">
            <span className="text-5xl font-semibold text-[var(--carysil-red)]">
              {data.retrievalSuccess.ctrPct}%
            </span>
            <span className="mt-2 text-sm text-gray-500">click-through rate</span>
            {data.retrievalSuccess.avgSimilarity !== null && (
              <span className="mt-1 text-xs text-gray-400">avg similarity at click: {data.retrievalSuccess.avgSimilarity}</span>
            )}
          </div>
        </ChartCard>
      </section>

      <section className="grid min-w-0 grid-cols-2 gap-4 lg:grid-cols-4">
        <MiniBarList title="Top Categories" rows={data.categoryCounts} />
        <MiniBarList title="Top Intents" rows={data.intentCounts} />
        <MiniBarList title="Top Cities" rows={data.cityCounts} />
        <MiniBarList title="Follow-up Stages" rows={data.followupStageCounts} />
      </section>

      <section className="min-w-0 max-w-full overflow-hidden rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-carysil-stone">Leads</h2>
            <p className="text-sm text-gray-500">Sorted by priority, then lead score.</p>
          </div>
        </div>
        <div className="mt-4">
          <LeadsBlock leads={data.recentLeads} />
        </div>
      </section>

      <section className="grid min-w-0 max-w-full gap-6 lg:grid-cols-2">
        <div className="min-w-0 max-w-full overflow-hidden rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
          <h2 className="text-lg font-semibold text-carysil-stone">Recent Queries</h2>
          <div className="mt-4 min-w-0 space-y-3">
            {data.recentAnalytics.length === 0 ? (
              <EmptyState>No analytics events yet.</EmptyState>
            ) : (
              <ShowMoreList initialCount={3}>
                {data.recentAnalytics.map((event, index) => (
                  <div
                    key={`${event.created_at.toISOString()}-${index}`}
                    className="min-w-0 max-w-full overflow-hidden rounded-xl bg-gray-50 p-3 sm:p-4"
                  >
                    <p className="break-words font-medium text-carysil-stone">{compactText(event.query, "Empty query")}</p>
                    <div className="mt-2 flex min-w-0 flex-wrap gap-2 text-xs text-gray-600">
                      <span className="max-w-full break-words rounded-full bg-white px-2 py-1">
                        Intent: {event.detected_intent || "Unknown"}
                      </span>
                      <span className="max-w-full break-words rounded-full bg-white px-2 py-1">
                        Category: {event.category || "Unknown"}
                      </span>
                      <span className="max-w-full break-words rounded-full bg-white px-2 py-1">
                        Budget: {event.budget_type || "Unknown"}
                      </span>
                      <span className="max-w-full break-words rounded-full bg-white px-2 py-1">
                        City: {event.city || "Unknown"}
                      </span>
                      <span className="max-w-full break-words rounded-full bg-white px-2 py-1">
                        {formatDashboardDate(event.created_at)}
                      </span>
                    </div>
                  </div>
                ))}
              </ShowMoreList>
            )}
          </div>
        </div>

        <div className="min-w-0 max-w-full overflow-hidden rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
          <h2 className="text-lg font-semibold text-carysil-stone">Recent Chat Events</h2>
          <div className="mt-4 min-w-0 space-y-3">
            {data.recentEvents.length === 0 ? (
              <EmptyState>No chat events yet.</EmptyState>
            ) : (
              <ShowMoreList initialCount={3}>
                {data.recentEvents.map((event, index) => (
                  <div
                    key={`${event.session_id}-${event.created_at.toISOString()}-${index}`}
                    className="min-w-0 max-w-full overflow-hidden rounded-xl bg-gray-50 p-3 sm:p-4"
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-gray-600">
                      <span className="max-w-full break-words rounded-full bg-white px-2 py-1">{event.role}</span>
                      <span className="max-w-full break-words rounded-full bg-white px-2 py-1">{event.event_type}</span>
                      <span className="max-w-full break-words rounded-full bg-white px-2 py-1">
                        {formatDashboardDate(event.created_at)}
                      </span>
                    </div>
                    <p className="mt-2 break-words text-sm text-carysil-stone">{compactText(event.message)}</p>
                    {Object.keys(event.metadata || {}).length > 0 && (
                      <pre className="mt-2 max-h-24 min-w-0 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-white p-2 font-mono text-[11px] leading-snug text-gray-500 sm:text-xs">
                        {JSON.stringify(event.metadata, null, 2)}
                      </pre>
                    )}
                  </div>
                ))}
              </ShowMoreList>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
