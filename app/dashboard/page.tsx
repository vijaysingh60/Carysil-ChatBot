import { getDbPool } from "@/lib/db";
import { formatDashboardDate } from "@/lib/dashboardFormat";
import { ensureLeadSchema } from "@/services/sessionService";
import { LeadsBlock } from "./LeadsBlock";
import { ShowMoreList } from "./ShowMore";

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
  totals: {
    sessions: number;
    leads: number;
    analyticsEvents: number;
    chatEvents: number;
    hotLeads: number;
    followupsAsked: number;
    leadsCaptured: number;
    dealerRequests: number;
  };
  categoryCounts: MetricRow[];
  intentCounts: MetricRow[];
  cityCounts: MetricRow[];
  followupStageCounts: MetricRow[];
  recentLeads: LeadRow[];
  recentAnalytics: AnalyticsRow[];
  recentEvents: EventRow[];
};

function toNumber(value: unknown): number {
  return Number(value || 0);
}

function compactText(value: string | null | undefined, fallback = "Not captured"): string {
  if (!value) return fallback;
  return value.length > 140 ? `${value.slice(0, 140)}...` : value;
}

async function getDashboardData(): Promise<DashboardData> {
  await ensureLeadSchema();
  const pool = getDbPool();

  const [
    totalsResult,
    categoryResult,
    intentResult,
    cityResult,
    followupStageResult,
    leadsResult,
    analyticsResult,
    eventsResult,
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
    }>(`
      SELECT
        (SELECT COUNT(*) FROM chat_sessions) AS sessions,
        (SELECT COUNT(*) FROM leads) AS leads,
        (SELECT COUNT(*) FROM analytics_events) AS analytics_events,
        (SELECT COUNT(*) FROM chat_events) AS chat_events,
        (SELECT COUNT(*) FROM leads WHERE lead_score >= 5) AS hot_leads,
        (SELECT COUNT(*) FROM chat_events WHERE event_type IN ('followup_question_asked', 'cross_sell_offered')) AS followups_asked,
        (SELECT COUNT(*) FROM chat_events WHERE event_type = 'lead_captured') AS leads_captured,
        (SELECT COUNT(*) FROM chat_events WHERE event_type IN ('dealer_results_shown', 'dealer_request')) AS dealer_requests
    `),
    pool.query<MetricRow>(`
      SELECT COALESCE(category, 'Unknown') AS label, COUNT(*) AS count
      FROM analytics_events
      GROUP BY COALESCE(category, 'Unknown')
      ORDER BY COUNT(*) DESC
      LIMIT 8
    `),
    pool.query<MetricRow>(`
      SELECT COALESCE(detected_intent, 'Unknown') AS label, COUNT(*) AS count
      FROM analytics_events
      GROUP BY COALESCE(detected_intent, 'Unknown')
      ORDER BY COUNT(*) DESC
      LIMIT 8
    `),
    pool.query<MetricRow>(`
      SELECT COALESCE(city, 'Unknown') AS label, COUNT(*) AS count
      FROM analytics_events
      GROUP BY COALESCE(city, 'Unknown')
      ORDER BY COUNT(*) DESC
      LIMIT 8
    `),
    pool.query<MetricRow>(`
      SELECT COALESCE(followup_stage, 'browsing') AS label, COUNT(*) AS count
      FROM leads
      GROUP BY COALESCE(followup_stage, 'browsing')
      ORDER BY COUNT(*) DESC
      LIMIT 8
    `),
    pool.query<LeadRow>(`
      SELECT session_id, name, phone, email, city, intent, interested_product,
             interested_products, followup_stage, lead_score, created_at, updated_at
      FROM leads
      ORDER BY lead_score DESC, COALESCE(updated_at, created_at) DESC
      LIMIT 20
    `),
    pool.query<AnalyticsRow>(`
      SELECT query, detected_intent, category, budget_type, city, created_at
      FROM analytics_events
      ORDER BY created_at DESC
      LIMIT 30
    `),
    pool.query<EventRow>(`
      SELECT session_id, role, event_type, message, metadata, created_at
      FROM chat_events
      ORDER BY created_at DESC
      LIMIT 30
    `),
  ]);

  const totals = totalsResult.rows[0];

  return {
    totals: {
      sessions: toNumber(totals.sessions),
      leads: toNumber(totals.leads),
      analyticsEvents: toNumber(totals.analytics_events),
      chatEvents: toNumber(totals.chat_events),
      hotLeads: toNumber(totals.hot_leads),
      followupsAsked: toNumber(totals.followups_asked),
      leadsCaptured: toNumber(totals.leads_captured),
      dealerRequests: toNumber(totals.dealer_requests),
    },
    categoryCounts: categoryResult.rows,
    intentCounts: intentResult.rows,
    cityCounts: cityResult.rows,
    followupStageCounts: followupStageResult.rows,
    recentLeads: leadsResult.rows,
    recentAnalytics: analyticsResult.rows,
    recentEvents: eventsResult.rows,
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

export default async function DashboardPage() {
  let data: DashboardData | null = null;
  let error: string | null = null;

  try {
    data = await getDashboardData();
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
              Live view of chat sessions, captured leads, product intent, locations, and recent conversation events.
            </p>
          </div>
          <p className="text-sm text-gray-400">Refresh the page to see latest data.</p>
        </div>
      </section>

      <section className="grid min-w-0 grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <MetricCard label="Sessions" value={data.totals.sessions} />
        <MetricCard label="Leads" value={data.totals.leads} />
        <MetricCard label="Hot Leads" value={data.totals.hotLeads} />
        <MetricCard label="Leads Captured" value={data.totals.leadsCaptured} />
        <MetricCard label="Follow-ups Asked" value={data.totals.followupsAsked} />
        <MetricCard label="Dealer Requests" value={data.totals.dealerRequests} />
        <MetricCard label="Analytics Events" value={data.totals.analyticsEvents} />
        <MetricCard label="Chat Events" value={data.totals.chatEvents} />
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
            <p className="text-sm text-gray-500">Sorted by lead score, then newest first.</p>
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
