/**
 * Chart color theme for the dashboard — derived from the Carysil brand red
 * (#c5222f) via the dataviz skill's OKLCH color formula and validated with
 * scripts/validate_palette.js:
 *   - [CHART_RED, CHART_GOLD] categorical pair: CVD ΔE 18.6 (target >= 12)
 *   - FUNNEL_RAMP (8-step ordinal): lightness-monotone, adjacent ΔL >= 0.06,
 *     light-end contrast 2.13:1 vs white — all PASS
 *   - LEAD_TIER_RAMP (4-step ordinal) / HEATMAP_RAMP (6-step sequential):
 *     same checks, all PASS
 * Regenerate via the skill if the brand red ever changes — these are not
 * hand-picked hex values.
 */

export const CHART_RED = "#c5222f";
export const CHART_GOLD = "#ab7400";

/** Light -> dark, one step per funnel stage (awareness -> converted). */
export const FUNNEL_RAMP = [
  "#dea39f",
  "#c98783",
  "#b36b67",
  "#9e504d",
  "#883433",
  "#72151a",
  "#5c0000",
  "#380000",
];

/** Light -> dark: cold, warm, hot, high_intent. */
export const LEAD_TIER_RAMP = ["#d3adaa", "#c56e6a", "#ac262d", "#840000"];

/** Light -> dark sequential ramp for the product-demand heatmap. */
export const HEATMAP_RAMP = ["#d5a39f", "#bf817c", "#a85f5b", "#913d3b", "#78161c", "#5f0000"];

export const STATUS = {
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
} as const;
