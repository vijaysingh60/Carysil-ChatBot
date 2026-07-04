import { SectionCard } from "./SectionCard";

export function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <SectionCard className="overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold text-carysil-stone sm:text-lg">{title}</h3>
        {subtitle ? <p className="text-xs text-gray-500">{subtitle}</p> : null}
      </div>
      <div className="mt-3">{children}</div>
    </SectionCard>
  );
}
