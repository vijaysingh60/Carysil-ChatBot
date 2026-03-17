"use client";

import { useRef, useState, useEffect } from "react";

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
  followups?: string[];
};

const WELCOME: ChatMessage = {
  id: "welcome",
  role: "assistant",
  content:
    "Hi there 👋\nYou are now speaking with AskCary. How can I help?",
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
  const [atBottom, setAtBottom] = useState(true);

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
        followups: Array.isArray(data.followups) ? data.followups : undefined,
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
        setAtBottom(true);
      }, 50);
    }
  }

  useEffect(() => {
    if (!open) return;
    let cleanup: (() => void) | undefined;
    const attach = (node: HTMLDivElement | null) => {
      if (!node) return;
      const onScroll = () => {
        const { scrollTop, scrollHeight, clientHeight } = node;
        setAtBottom(scrollTop + clientHeight >= scrollHeight - 50);
      };
      node.addEventListener("scroll", onScroll);
      onScroll();
      cleanup = () => node.removeEventListener("scroll", onScroll);
    };
    if (listRef.current) attach(listRef.current);
    else {
      const t = setTimeout(() => attach(listRef.current), 150);
      return () => {
        clearTimeout(t);
        cleanup?.();
      };
    }
    return () => cleanup?.();
  }, [open]);

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
          className="fixed bottom-24 right-6 z-[9998] flex w-[480px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-3xl border border-gray-800/80 bg-[#14161A] shadow-2xl shadow-black/60 h-[min(760px,calc(100vh-6rem))] max-sm:h-[min(680px,calc(100vh-10rem))]"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b-2 border-white/5 bg-[#14161A] px-5 py-3.5">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--carysil-red)] shadow-md shadow-[var(--carysil-red)]/40">
                <svg className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.864 9.864 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                  />
                </svg>
              </span>
              <div>
                <p className="text-base font-semibold text-white">AskCary</p>
                <p className="text-sm text-gray-400">Carysil AI assistant</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-full p-1.5 text-gray-500 hover:bg-white/10 hover:text-white transition"
              aria-label="Close"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Messages */}
          <div className="relative flex-1 flex flex-col min-h-0">
            <div
              ref={listRef}
              className="flex-1 overflow-y-auto bg-[#14161A] p-5 space-y-4"
            >
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[90%] rounded-2xl px-4 py-3 text-base whitespace-pre-wrap ${
                    m.role === "user"
                      ? "bg-[var(--carysil-red)] text-white shadow-lg shadow-[var(--carysil-red)]/40"
                      : "bg-[#2c2d31] text-gray-100 border border-white/5 shadow-md"
                  }`}
                >
                  {m.content}
                  {m.role === "assistant" && m.dealers && m.dealers.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {m.dealers.slice(0, 6).map((dealer) => (
                        <div
                          key={dealer.id}
                          className="rounded-lg border border-white/5 bg-[#14161A] text-black p-3.5 text-left"
                        >
                          <p className="font-medium text-gray-100 text-base">{dealer.name}</p>
                          <p className="text-sm text-gray-400 mt-0.5">{dealer.city}, {dealer.state}</p>
                          <p className="text-sm text-gray-300 mt-1">{dealer.phone}</p>
                          <a
                            href={`mailto:${dealer.contact_email}`}
                            className="text-sm text-[var(--carysil-red)] font-medium hover:underline"
                          >
                            {dealer.contact_email}
                          </a>
                        </div>
                      ))}
                    </div>
                  )}
                  {m.role === "assistant" && m.followups && m.followups.length > 0 && (
                    <div className="mt-3 flex flex-col gap-2">
                      {m.followups.map((q) => (
                        <div
                          key={q}
                          className="rounded-2xl border border-[var(--carysil-red)]/70 bg-transparent px-4 py-3 text-sm sm:text-base text-gray-100"
                        >
                          {q}
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
                          className="flex gap-2 rounded-xl border border-white/5 bg-[#14161A] text-black p-2 hover:border-[var(--carysil-red)]/60 transition-colors text-left"
                        >
                          {rec.image_url && (
                            <img
                              src={rec.image_url}
                              alt={rec.name}
                              className="h-14 w-14 shrink-0 rounded-md object-cover bg-black/40"
                            />
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="font-medium text-gray-100 text-base line-clamp-2">{rec.name}</p>
                            {rec.price && <p className="mt-0.5 text-base text-gray-400">{rec.price}</p>}
                            <span className="text-base text-[var(--carysil-red)] font-medium">View →</span>
                          </div>
                        </a>
                      ))}
                    </div>
                  )}
                  {m.role === "assistant" && m.meta?.error === "quota_exceeded" && (
                    <p className="mt-2 text-base text-red-600">Service temporarily limited. Please try again later.</p>
                  )}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className="max-w-[90%] rounded-2xl border border-white/5 bg-[#181a21] px-4 py-3 shadow-sm">
                  <span className="inline-flex gap-1.5 items-center">
                    <span className="h-2 w-2 rounded-full bg-gray-400 animate-thinking-dot" />
                    <span className="h-2 w-2 rounded-full bg-gray-400 animate-thinking-dot-2" />
                    <span className="h-2 w-2 rounded-full bg-gray-400 animate-thinking-dot-3" />
                  </span>
                </div>
              </div>
            )}
            </div>
            {!atBottom && (
              <button
                type="button"
                onClick={() =>
                  listRef.current?.scrollTo({
                    top: listRef.current.scrollHeight,
                    behavior: "smooth",
                  })
                }
                className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex h-12 w-12 items-center justify-center rounded-full border-2 border-gray-300 bg-[#2a2a2e] text-white shadow-[0_4px_20px_rgba(0,0,0,0.5)] ring-2 ring-black/20 hover:bg-[#35353a] hover:border-gray-200 transition"
                aria-label="Scroll to latest messages"
              >
                <svg
                  className="h-5 w-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M7 10L12 15L17 10"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
          </div>

          {/* Input */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
            className="border-t border-white/5 bg-[#14161A] px-5 py-4"
          >
            <div className="flex items-center">
              <div className="flex w-full items-center gap-2 rounded-2xl border border-white/20 bg-[#14161A] px-4 py-3 shadow-[0_2px_8px_rgba(0,0,0,0.4)] focus-within:border-[var(--carysil-red)] focus-within:ring-1 focus-within:ring-[var(--carysil-red)] focus-within:shadow-[0_0_0_3px_rgba(220,38,38,0.15)] transition">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Message..."
                  className="flex-1 bg-transparent border-none text-base text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-0"
                />
                <button
                  type="submit"
                  disabled={!canSend}
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--carysil-red)] text-white shadow-md shadow-[var(--carysil-red)]/40 hover:opacity-90 disabled:opacity-40 transition"
                >
                  <svg
                    className="h-5 w-5"
                    viewBox="0 0 24 24"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      d="M12 5L18 11M12 5L6 11M12 5V19"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </div>
            </div>
            <p className="mt-2.5 flex items-center justify-center gap-2 text-center text-sm text-gray-500">
              <img
                src="/favicon.webp"
                alt="Carysil logo"
                className="h-5 w-5 rounded-sm"
              />
              <span>Powered by Carysil</span>
            </p>
          </form>
        </div>
      )}
    </>
  );
}
