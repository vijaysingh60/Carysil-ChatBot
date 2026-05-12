import Link from "next/link";

const RANGES: Array<{ value: string; label: string }> = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "all", label: "All time" },
];

export function RangeSelector({ active }: { active: string }) {
  return (
    <div className="inline-flex rounded-full border border-gray-200 bg-white p-1 text-xs shadow-sm">
      {RANGES.map((range) => {
        const isActive = range.value === active;
        return (
          <Link
            key={range.value}
            href={`/dashboard?range=${range.value}`}
            className={`px-3 py-1.5 rounded-full transition ${
              isActive
                ? "bg-[var(--carysil-red)] text-white shadow"
                : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            {range.label}
          </Link>
        );
      })}
    </div>
  );
}
