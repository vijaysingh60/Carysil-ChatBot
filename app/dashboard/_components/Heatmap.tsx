export type HeatmapCell = { row: string; col: string; value: number };

export function Heatmap({
  rows,
  cols,
  cells,
  emptyText = "No data yet.",
}: {
  rows: string[];
  cols: string[];
  cells: HeatmapCell[];
  emptyText?: string;
}) {
  if (rows.length === 0 || cols.length === 0 || cells.length === 0) {
    return <p className="text-sm text-gray-500">{emptyText}</p>;
  }
  const max = cells.reduce((acc, cell) => Math.max(acc, cell.value), 0) || 1;
  const matrix = new Map<string, number>();
  for (const cell of cells) matrix.set(`${cell.row}|${cell.col}`, cell.value);

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-separate border-spacing-0 text-xs">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-white p-2 text-left text-[10px] uppercase tracking-wide text-gray-500">
              Category \ City
            </th>
            {cols.map((col) => (
              <th
                key={col}
                className="p-2 text-left text-[10px] uppercase tracking-wide text-gray-500"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row}>
              <td className="sticky left-0 z-10 bg-white p-2 font-medium text-carysil-stone">{row}</td>
              {cols.map((col) => {
                const value = matrix.get(`${row}|${col}`) ?? 0;
                const intensity = value === 0 ? 0 : 0.15 + (value / max) * 0.7;
                return (
                  <td key={col} className="p-1">
                    <div
                      className="flex h-9 min-w-[2.5rem] items-center justify-center rounded-md text-[11px] font-medium text-carysil-stone"
                      style={{ background: `rgba(220,38,38,${intensity.toFixed(2)})` }}
                      title={`${row} / ${col}: ${value}`}
                    >
                      {value > 0 ? value : ""}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
