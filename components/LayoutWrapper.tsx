"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function LayoutWrapper({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isEmbed = pathname?.startsWith("/embed");

  if (isEmbed) {
    return <>{children}</>;
  }

  return (
    <>
      <header className="border-b border-gray-200 bg-white sticky top-0 z-10 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <Link
            href="/"
            className="text-xl font-semibold tracking-tight text-carysil-stone"
          >
            Carysil <span className="text-carysil-red">AI</span>
          </Link>
          <nav className="flex items-center gap-6 text-sm text-carysil-stone/80">
            <Link
              href="/"
              className="hover:text-carysil-red transition-colors font-medium"
            >
              Home
            </Link>
            <a
              href="https://www.carysil.com/reach-us"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-carysil-red transition-colors"
            >
              Contact
            </a>
            <a
              href="https://www.carysil.com"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-carysil-red transition-colors"
            >
              Main site
            </a>
          </nav>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8">{children}</main>
      <footer className="border-t border-gray-200 bg-white mt-12">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 flex flex-wrap items-center justify-between gap-4 text-sm text-gray-500">
          <span>© Carysil. AI Concierge prototype.</span>
          <div className="flex gap-6">
            <a href="https://www.carysil.com" target="_blank" rel="noopener noreferrer" className="hover:text-carysil-red transition-colors">Carysil.com</a>
            <a href="https://www.carysil.com/reach-us" target="_blank" rel="noopener noreferrer" className="hover:text-carysil-red transition-colors">Contact</a>
          </div>
        </div>
      </footer>
    </>
  );
}
