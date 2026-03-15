"use client";

import { useRef, useState } from "react";

type Recommendation = {
  id: string;
  name: string;
  price?: string;
  image_url?: string;
  url?: string;
  description?: string;
};

type Dealer = {
  id: string;
  name: string;
  city: string;
  state: string;
  products_supported: string[];
  contact_email: string;
  phone: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  meta?: { aiUsed?: boolean; error?: string };
  recommendations?: Recommendation[];
  dealers?: Dealer[];
  reasoning?: string | null;
};

const WELCOME: ChatMessage = {
  id: "welcome",
  role: "assistant",
  content:
    "Hi — I'm Carysil Concierge. Ask me for product recommendations, dealer routing, installation support, or design suggestions.",
  meta: undefined,
};

const EXAMPLE_PROMPTS = [
  "Recommend quartz sinks for a modern kitchen, medium budget.",
  "I need a kitchen faucet. What do you have?",
  "Food waste disposer for a family of 5.",
  "Which dealer in Hyderabad?",
  "Where can I buy Carysil in Mumbai?",
];

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME]);
  const listRef = useRef<HTMLDivElement>(null);

  const canSend = input.trim().length > 0 && !loading;

  async function send(messageText: string) {
    const text = messageText.trim();
    if (!text) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/ai/concierge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");

      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: String(data.result || ""),
        meta: { aiUsed: data.aiUsed ?? false, error: data.error },
        recommendations: Array.isArray(data.recommendations) ? data.recommendations : undefined,
        dealers: Array.isArray(data.dealers) ? data.dealers : undefined,
        reasoning: data.reasoning ?? null,
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: "Something went wrong. Please try again.",
          meta: { aiUsed: false, error: "api_error" },
        },
      ]);
    } finally {
      setLoading(false);
      setTimeout(() => {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
      }, 50);
    }
  }

  return (
    <>
      {/* Floating chat button */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-6 right-6 z-[9999] flex h-14 w-14 items-center justify-center rounded-full bg-[var(--carysil-red)] text-white shadow-lg transition-all hover:scale-105 hover:shadow-xl focus:outline-none focus:ring-2 focus:ring-[var(--carysil-red)] focus:ring-offset-2"
        aria-label={open ? "Close chat" : "Open chat"}
      >
        {open ? (
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : (
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.864 9.864 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          </svg>
        )}
      </button>

      {/* Chat window */}
      {open && (
        <div
          className="fixed bottom-24 right-6 z-[9998] flex w-[420px] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xl"
          style={{ height: "min(640px, calc(100vh - 7rem))" }}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-gray-100 bg-[var(--carysil-stone)] px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--carysil-red)]">
                <svg className="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.864 9.864 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                  />
                </svg>
              </span>
              <div>
                <p className="text-sm font-semibold text-white">Carysil Concierge</p>
                <p className="text-xs text-gray-400">We typically reply in seconds</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-lg p-1.5 text-gray-400 hover:bg-white/10 hover:text-white"
              aria-label="Close"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Messages */}
          <div
            ref={listRef}
            className="flex-1 overflow-y-auto bg-gray-50/80 p-4 space-y-3"
          >
            {messages.length <= 1 && (
              <div className="mb-2">
                <p className="text-sm font-medium text-gray-500 mb-2">Try asking:</p>
                <div className="flex flex-wrap gap-1.5">
                  {EXAMPLE_PROMPTS.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => void send(prompt)}
                      className="rounded-full bg-white border border-gray-200 px-3 py-2 text-sm text-[var(--carysil-stone)] hover:border-[var(--carysil-red)]/50 hover:bg-[var(--carysil-red)]/5 transition-colors"
                    >
                      {prompt.length > 36 ? prompt.slice(0, 36) + "…" : prompt}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[90%] rounded-2xl px-4 py-3 text-base whitespace-pre-wrap ${
                    m.role === "user"
                      ? "bg-[var(--carysil-red)] text-white"
                      : "bg-white text-[var(--carysil-stone)] border border-gray-100 shadow-sm"
                  }`}
                >
                  {m.content}
                  {m.role === "assistant" && m.reasoning && (
                    <p className="mt-2 text-sm text-gray-500 italic border-l-2 border-[var(--carysil-red)]/30 pl-2">
                      Why we chose these: {m.reasoning}
                    </p>
                  )}
                  {m.role === "assistant" && m.dealers && m.dealers.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {m.dealers.slice(0, 6).map((dealer) => (
                        <div
                          key={dealer.id}
                          className="rounded-lg border border-gray-100 bg-gray-50/80 p-3 text-left"
                        >
                          <p className="font-medium text-[var(--carysil-stone)] text-sm">{dealer.name}</p>
                          <p className="text-xs text-gray-500 mt-0.5">{dealer.city}, {dealer.state}</p>
                          <p className="text-xs text-gray-600 mt-1">{dealer.phone}</p>
                          <a
                            href={`mailto:${dealer.contact_email}`}
                            className="text-xs text-[var(--carysil-red)] font-medium hover:underline"
                          >
                            {dealer.contact_email}
                          </a>
                        </div>
                      ))}
                    </div>
                  )}
                  {m.role === "assistant" && m.recommendations && m.recommendations.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {m.recommendations.slice(0, 4).map((rec) => (
                        <a
                          key={rec.id}
                          href={rec.url || "#"}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex gap-2 rounded-lg border border-gray-100 bg-gray-50/80 p-2 hover:border-[var(--carysil-red)]/30 transition-colors text-left"
                        >
                          {rec.image_url && (
                            <img
                              src={rec.image_url}
                              alt={rec.name}
                              className="h-14 w-14 shrink-0 rounded-md object-cover bg-gray-100"
                            />
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="font-medium text-[var(--carysil-stone)] text-sm line-clamp-2">{rec.name}</p>
                            {rec.price && <p className="mt-0.5 text-sm text-gray-500">{rec.price}</p>}
                            <span className="text-sm text-[var(--carysil-red)] font-medium">View →</span>
                          </div>
                        </a>
                      ))}
                    </div>
                  )}
                  {m.role === "assistant" && m.meta?.error === "quota_exceeded" && (
                    <p className="mt-2 text-sm text-red-600">Service temporarily limited. Please try again later.</p>
                  )}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className="max-w-[90%] rounded-2xl border border-gray-100 bg-white px-4 py-3 shadow-sm">
                  <span className="inline-flex gap-1 items-center">
                    <span className="h-1.5 w-1.5 rounded-full bg-gray-400 animate-thinking-dot" />
                    <span className="h-1.5 w-1.5 rounded-full bg-gray-400 animate-thinking-dot-2" />
                    <span className="h-1.5 w-1.5 rounded-full bg-gray-400 animate-thinking-dot-3" />
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Input */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
            className="border-t border-gray-100 bg-white p-3"
          >
            <div className="flex gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask about products, dealers, installation…"
                className="flex-1 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-base text-[var(--carysil-stone)] placeholder:text-gray-400 focus:border-[var(--carysil-red)] focus:bg-white focus:outline-none focus:ring-1 focus:ring-[var(--carysil-red)]"
              />
              <button
                type="submit"
                disabled={!canSend}
                className="rounded-xl bg-[var(--carysil-red)] px-4 py-3 text-base font-medium text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                Send
              </button>
            </div>
            <p className="mt-2 text-center text-xs text-gray-400">
              Powered by Carysil AI
            </p>
          </form>
        </div>
      )}
    </>
  );
}
