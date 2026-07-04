import Link from "next/link";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-carysil-sand">
      <header className="sticky top-0 z-10 border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-screen-2xl items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-baseline gap-2">
            <span className="text-base font-semibold tracking-tight text-carysil-stone">
              Carysil <span className="text-carysil-red">AI</span>
            </span>
            <span className="text-sm text-gray-400">/</span>
            <span className="text-sm font-medium text-gray-500">Dashboard</span>
          </div>
          <Link
            href="/"
            className="text-sm text-gray-500 transition-colors hover:text-carysil-red"
          >
            ← Back to site
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
