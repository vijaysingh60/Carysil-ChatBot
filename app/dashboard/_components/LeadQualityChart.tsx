"use client";

import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";

export type LeadQualityPoint = {
  day: string;
  cold: number;
  warm: number;
  hot: number;
  high_intent: number;
};

export function LeadQualityChart({ data }: { data: LeadQualityPoint[] }) {
  if (data.length === 0) {
    return <p className="text-sm text-gray-500">No leads yet for this range.</p>;
  }
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f1f1" />
          <XAxis dataKey="day" stroke="#9ca3af" fontSize={11} />
          <YAxis stroke="#9ca3af" fontSize={11} allowDecimals={false} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="cold" stackId="a" fill="#a3a3a3" />
          <Bar dataKey="warm" stackId="a" fill="#f59e0b" />
          <Bar dataKey="hot" stackId="a" fill="#ef4444" />
          <Bar dataKey="high_intent" stackId="a" fill="#7f1d1d" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
