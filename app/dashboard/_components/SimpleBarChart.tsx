"use client";

import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

export type SimpleBarPoint = {
  label: string;
  value: number;
};

export function SimpleBarChart({
  data,
  color = "#dc2626",
  emptyText = "No data yet.",
}: {
  data: SimpleBarPoint[];
  color?: string;
  emptyText?: string;
}) {
  if (data.length === 0) {
    return <p className="text-sm text-gray-500">{emptyText}</p>;
  }
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f1f1" />
          <XAxis dataKey="label" stroke="#6b7280" fontSize={11} interval={0} angle={-20} textAnchor="end" height={50} />
          <YAxis stroke="#9ca3af" fontSize={11} allowDecimals={false} />
          <Tooltip />
          <Bar dataKey="value" fill={color} radius={[6, 6, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
