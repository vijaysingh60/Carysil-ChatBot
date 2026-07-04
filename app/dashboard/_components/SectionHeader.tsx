export function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="min-w-0">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500">{title}</h2>
      {description ? <p className="mt-1 text-sm text-gray-500">{description}</p> : null}
    </div>
  );
}
