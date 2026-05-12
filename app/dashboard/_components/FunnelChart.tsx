"use client";

import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell,
} from "recharts";

export type FunnelStagePoint = {
  stage: string;
  sessions: number;
  dropOffPct?: number;
};

const STAGE_COLORS = [
  "#9ca3af",
  "#fcd34d",
  "#fbbf24",
  "#f97316",
  "#ef4444",
  "#dc2626",
  "#b91c1c",
  "#7f1d1d",
];

export function FunnelChart({ data }: { data: FunnelStagePoint[] }) {
  if (data.length === 0) {
    return <p className="text-sm text-gray-500">No funnel transitions yet.</p>;
  }
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 8, right: 32, left: 16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f1f1" />
          <XAxis type="number" stroke="#9ca3af" fontSize={11} allowDecimals={false} />
          <YAxis type="category" dataKey="stage" stroke="#374151" fontSize={11} width={120} />
          <Tooltip
            formatter={(value, _name, item) => {
              const sessions =
                typeof value === "number"
                  ? value
                  : typeof value === "string"
                    ? Number(value)
                    : 0;
              const display = Number.isFinite(sessions) ? sessions : 0;
              const drop = (item?.payload as FunnelStagePoint | undefined)?.dropOffPct;
              const dropLabel = typeof drop === "number" ? ` (drop ${drop.toFixed(1)}%)` : "";
              return [`${display}${dropLabel}`, "Sessions"];
            }}
          />
          <Bar dataKey="sessions" radius={[0, 6, 6, 0]}>
            {data.map((_, index) => (
              <Cell key={`cell-${index}`} fill={STAGE_COLORS[index % STAGE_COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
