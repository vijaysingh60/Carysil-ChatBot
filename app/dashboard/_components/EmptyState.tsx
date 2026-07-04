export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-w-0 max-w-full break-words rounded-lg border border-dashed border-gray-300 bg-gray-50 p-6 text-sm text-gray-500">
      {children}
    </div>
  );
}
