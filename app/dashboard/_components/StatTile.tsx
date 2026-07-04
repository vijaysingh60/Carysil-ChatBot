export function StatTile({
  label,
  value,
  support,
}: {
  label: string;
  value: string;
  support?: string;
}) {
  return (
    <div className="flex h-64 min-w-0 flex-col justify-center">
      <p className="text-sm text-gray-500">{label}</p>
      {/* Hero figure: proportional (not tabular) figures — a large standalone
          value reads better with the font's default digit widths. */}
      <p className="mt-2 text-6xl font-semibold text-carysil-red">{value}</p>
      {support ? <p className="mt-2 text-sm text-gray-500">{support}</p> : null}
    </div>
  );
}
