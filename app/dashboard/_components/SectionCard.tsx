export function SectionCard({
  children,
  padding = "md",
  className = "",
}: {
  children: React.ReactNode;
  padding?: "sm" | "md";
  className?: string;
}) {
  const pad = padding === "sm" ? "p-3 sm:p-4" : "p-4 sm:p-5";
  return (
    <div className={`min-w-0 max-w-full rounded-xl border border-gray-200 bg-white ${pad} ${className}`}>
      {children}
    </div>
  );
}
