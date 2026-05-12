export type FunnelStage =
  | "awareness"
  | "discovery"
  | "consideration"
  | "comparison"
  | "dealer_ready"
  | "quotation_ready"
  | "conversion_ready"
  | "converted";

export const FUNNEL_STAGES: FunnelStage[] = [
  "awareness",
  "discovery",
  "consideration",
  "comparison",
  "dealer_ready",
  "quotation_ready",
  "conversion_ready",
  "converted",
];

const FUNNEL_RANK: Record<FunnelStage, number> = {
  awareness: 0,
  discovery: 1,
  consideration: 2,
  comparison: 3,
  dealer_ready: 4,
  quotation_ready: 5,
  conversion_ready: 6,
  converted: 7,
};

export function funnelRank(stage: FunnelStage | null | undefined): number {
  if (!stage) return -1;
  return FUNNEL_RANK[stage] ?? -1;
}

export function isFunnelStage(value: unknown): value is FunnelStage {
  return typeof value === "string" && value in FUNNEL_RANK;
}

export type LeadTier = "cold" | "warm" | "hot" | "high_intent";

export function scoreToTier(score: number): LeadTier {
  if (score <= 4) return "cold";
  if (score <= 12) return "warm";
  if (score <= 25) return "hot";
  return "high_intent";
}
