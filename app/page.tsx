import Link from "next/link";

export default function HomePage() {
  return (
    <div className="min-h-[70vh]">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-2xl bg-[var(--carysil-stone)] px-6 py-16 sm:px-10 sm:py-24 text-white">
        <div className="absolute inset-0 bg-[linear-gradient(135deg,var(--carysil-charcoal)_0%,transparent_50%)]" />
        <div className="relative max-w-2xl">
          <p className="text-sm font-medium uppercase tracking-widest text-[var(--carysil-red)]">
            AI-Powered Concierge
          </p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">
            Find the right Carysil products for your kitchen & bathroom
          </h1>
          <p className="mt-5 text-lg text-gray-300">
            Get personalised recommendations for sinks, faucets, food waste disposers, and more. Ask about dealers, installation, or design—our assistant is here to help.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <a
              href="https://www.carysilshop.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-xl bg-[var(--carysil-red)] px-6 py-3 text-sm font-medium text-white hover:opacity-90 transition-opacity"
            >
              Shop at Carysil
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
            <p className="text-sm text-gray-400">
              Or tap the chat button to ask anything →
            </p>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="mt-16 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
        {[
          {
            title: "Product recommendations",
            description: "Tell us what you need—sinks, faucets, disposers, or accessories—and get tailored picks with prices and links.",
            icon: "M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10",
          },
          {
            title: "Dealer routing",
            description: "Share your city or region and we’ll point you to the right Carysil dealer.",
            icon: "M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z M15 11a3 3 0 11-6 0 3 3 0 016 0z",
          },
          {
            title: "Installation & support",
            description: "Questions about fitting or troubleshooting? Get clear, step-by-step guidance.",
            icon: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z",
          },
          {
            title: "Design ideas",
            description: "Planning a luxury or modern setup? Get architect-friendly suggestions for sinks and fittings.",
            icon: "M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5z M4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6z M16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z",
          },
        ].map((item) => (
          <div
            key={item.title}
            className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm transition-shadow hover:shadow-md"
          >
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--carysil-red)]/10 text-[var(--carysil-red)]">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
              </svg>
            </span>
            <h2 className="mt-4 text-lg font-semibold text-[var(--carysil-stone)]">{item.title}</h2>
            <p className="mt-2 text-sm text-gray-600">{item.description}</p>
          </div>
        ))}
      </section>

      {/* CTA strip */}
      <section className="mt-20 rounded-2xl border border-gray-200 bg-[var(--carysil-sand)] px-6 py-10 sm:px-10 text-center">
        <h2 className="text-xl font-semibold text-[var(--carysil-stone)]">
          Ready to get started?
        </h2>
        <p className="mt-2 text-gray-600">
          Open the chat in the bottom-right corner and ask anything—products, dealers, or installation help.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-4 text-sm">
          <Link
            href="https://www.carysil.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--carysil-red)] font-medium hover:underline"
          >
            Carysil.com
          </Link>
          <span className="text-gray-400">·</span>
          <Link
            href="https://www.carysil.com/reach-us"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--carysil-red)] font-medium hover:underline"
          >
            Contact us
          </Link>
        </div>
      </section>
    </div>
  );
}
