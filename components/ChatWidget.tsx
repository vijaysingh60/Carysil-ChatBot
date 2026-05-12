"use client";

import { useRef, useState, useEffect, useLayoutEffect, useCallback } from "react";

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

const SESSION_STORAGE_KEY = "askcary_session_id";
const CHAT_MESSAGES_PREFIX = "askcary_chat_messages_v1:";
const MAX_PERSISTED_MESSAGES = 80;

function chatStorageKey(sessionId: string): string {
  return `${CHAT_MESSAGES_PREFIX}${sessionId}`;
}

function loadPersistedMessages(sessionId: string): ChatMessage[] | null {
  if (typeof window === "undefined" || !sessionId) return null;
  try {
    const raw = window.localStorage.getItem(chatStorageKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const cleaned = parsed.filter(
      (row): row is ChatMessage =>
        row &&
        typeof row === "object" &&
        typeof (row as ChatMessage).id === "string" &&
        ((row as ChatMessage).role === "user" || (row as ChatMessage).role === "assistant") &&
        typeof (row as ChatMessage).content === "string"
    );
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    return null;
  }
}

function savePersistedMessages(sessionId: string, messages: ChatMessage[]): void {
  if (typeof window === "undefined" || !sessionId) return;
  try {
    const slice =
      messages.length > MAX_PERSISTED_MESSAGES
        ? messages.slice(-MAX_PERSISTED_MESSAGES)
        : messages;
    window.localStorage.setItem(chatStorageKey(sessionId), JSON.stringify(slice));
  } catch (e) {
    console.warn("[chat] could not persist messages", e);
  }
}

const WELCOME: ChatMessage = {
  id: "welcome",
  role: "assistant",
  content:
    "Hi there 👋\nYou are now speaking with AskCary. How can I help?",
  meta: undefined,
};

/** ~max-h-48 (12rem); textarea grows until this then scrolls */
const TEXTAREA_MAX_HEIGHT_PX = 192;

const EXAMPLE_PROMPTS = [
  "Recommend quartz sinks for a modern kitchen, medium budget.",
  "I need a kitchen faucet. What do you have?",
  "Food waste disposer for a family of 5.",
  "Which dealer in Hyderabad?",
  "Where can I buy Carysil in Mumbai?",
];

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [closing, setClosing] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME]);
  const [sessionId, setSessionId] = useState<string>("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const skipPersistRef = useRef(true);

  const canSend = input.trim().length > 0 && !loading;

  const scrollChatToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const node = listRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
  }, []);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || !rendered) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX);
    el.style.height = `${next}px`;
  }, [input, rendered]);

  /** Keep latest user message + typing row in view (scroll was only in fetch `finally`, so they sat under the fold). */
  useLayoutEffect(() => {
    if (!rendered) return;
    scrollChatToBottom("auto");
    requestAnimationFrame(() => scrollChatToBottom("auto"));
  }, [messages, loading, rendered, scrollChatToBottom]);

  function toggleOpen() {
    setPressed(true);
    window.setTimeout(() => setPressed(false), 220);
    if (open) {
      setClosing(true);
      setOpen(false);
      window.setTimeout(() => {
        setClosing(false);
        setRendered(false);
      }, 200);
    } else {
      setRendered(true);
      setClosing(false);
      setOpen(true);
    }
  }

  function closeChat() {
    if (!open && !rendered) return;
    setClosing(true);
    setOpen(false);
    window.setTimeout(() => {
      setClosing(false);
      setRendered(false);
    }, 200);
  }

  async function send(messageText: string) {
    const text = messageText.trim();
    if (!text) return;
    const history = messages
      .filter((message) => message.id !== "welcome")
      .slice(-8)
      .map((message) => {
        let content = message.content;
        if (message.role === "assistant" && message.followups?.length) {
          content = [message.content, ...message.followups].filter(Boolean).join("\n\n");
        }
        return { role: message.role, content };
      });

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
        body: JSON.stringify({
          message: text,
          history,
          sessionId: sessionId || undefined,
          source: "chat_widget",
          deviceType: window.innerWidth < 768 ? "mobile" : "desktop",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      if (typeof data.sessionId === "string" && data.sessionId) {
        setSessionId(data.sessionId);
        window.localStorage.setItem(SESSION_STORAGE_KEY, data.sessionId);
      }

      const multiRaw = data.assistantMessages;
      const multi =
        Array.isArray(multiRaw) && multiRaw.length > 0
          ? (multiRaw as Array<{
              result?: string;
              recommendations?: Recommendation[];
              dealers?: Dealer[];
              followups?: string[];
              aiUsed?: boolean;
              error?: string;
            }>)
          : null;

      if (multi) {
        const baseAi = Boolean(data.aiUsed);
        const baseErr = typeof data.error === "string" ? data.error : undefined;
        const turns: ChatMessage[] = multi.map((turn) => {
          const fromFollowups = Array.isArray(turn.followups) ? turn.followups.filter(Boolean) : [];
          return {
            id: crypto.randomUUID(),
            role: "assistant",
            content: String(turn.result || ""),
            meta: { aiUsed: turn.aiUsed ?? baseAi, error: turn.error ?? baseErr },
            recommendations: Array.isArray(turn.recommendations) ? turn.recommendations : undefined,
            dealers: Array.isArray(turn.dealers) ? turn.dealers : undefined,
            reasoning: data.reasoning ?? null,
            followups: fromFollowups.length > 0 ? fromFollowups : undefined,
          };
        });
        setMessages((prev) => [...prev, ...turns]);
      } else {
        const fromFollowups = Array.isArray(data.followups) ? (data.followups as string[]).filter(Boolean) : [];
        const fq =
          typeof data.followupQuestion === "string" && data.followupQuestion.trim()
            ? data.followupQuestion.trim()
            : "";
        const mergedFollowups =
          fromFollowups.length > 0
            ? fromFollowups
            : fq
              ? [fq]
              : [];

        const assistantMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: String(data.result || ""),
          meta: { aiUsed: data.aiUsed ?? false, error: data.error },
          recommendations: Array.isArray(data.recommendations) ? data.recommendations : undefined,
          dealers: Array.isArray(data.dealers) ? data.dealers : undefined,
          reasoning: data.reasoning ?? null,
          followups: mergedFollowups.length > 0 ? mergedFollowups : undefined,
        };
        setMessages((prev) => [...prev, assistantMsg]);
      }
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
        scrollChatToBottom("smooth");
        setAtBottom(true);
      }, 50);
    }
  }

  useEffect(() => {
    let existingSessionId = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!existingSessionId) {
      existingSessionId = crypto.randomUUID();
      window.localStorage.setItem(SESSION_STORAGE_KEY, existingSessionId);
    }
    setSessionId(existingSessionId);
    const restored = loadPersistedMessages(existingSessionId);
    if (restored) {
      setMessages(restored);
    } else {
      setMessages([WELCOME]);
    }
    skipPersistRef.current = true;
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    if (skipPersistRef.current) {
      skipPersistRef.current = false;
      return;
    }
    const hasUserTurn = messages.some((m) => m.role === "user");
    if (!hasUserTurn) return;
    savePersistedMessages(sessionId, messages);
  }, [messages, sessionId]);

  useEffect(() => {
    if (!rendered) return;
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
  }, [rendered]);

  /** Opening the panel should land on the latest thread, not the top (e.g. long persisted history). */
  useEffect(() => {
    if (!rendered) return;

    const scrollToBottom = () => {
      scrollChatToBottom("auto");
      setAtBottom(true);
    };

    scrollToBottom();
    const raf = requestAnimationFrame(() => scrollToBottom());
    const t0 = window.setTimeout(scrollToBottom, 0);
    const t1 = window.setTimeout(scrollToBottom, 80);
    const t2 = window.setTimeout(scrollToBottom, 250);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t0);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [rendered, scrollChatToBottom]);

  return (
    <>
      {/* Floating chat button */}
      {!rendered && (
        <button
          type="button"
          onClick={toggleOpen}
          className={`fixed bottom-6 right-6 z-[9999] flex h-12 w-12 items-center justify-center rounded-full bg-[var(--carysil-red)] text-white shadow-lg transition-all hover:scale-105 hover:shadow-xl focus:outline-none focus:ring-2 focus:ring-[var(--carysil-red)] focus:ring-offset-2 ${
            pressed ? "animate-chat-button-press" : ""
          }`}
          aria-label="Open chat"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.864 9.864 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          </svg>
        </button>
      )}

      {/* Chat window */}
      {rendered && (
        <div
          className={`fixed bottom-6 right-6 z-[9998] flex w-[430px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-3xl border border-gray-800/80 bg-[#14161A] shadow-2xl shadow-black/60 h-[min(670px,calc(100vh-3rem))] max-sm:h-[min(600px,calc(100vh-7rem))] ${
            closing ? "animate-chat-pop-out pointer-events-none" : "animate-chat-pop-in"
          }`}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b-2 border-white/5 bg-[#14161A] px-4 py-3">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--carysil-red)] shadow-md shadow-[var(--carysil-red)]/40">
                <svg className="h-[18px] w-[18px] text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.864 9.864 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                  />
                </svg>
              </span>
              <div>
                <p className="text-xs font-semibold text-white sm:text-sm">AskCary</p>
                <p className="text-[11px] text-gray-400 sm:text-xs">Carysil AI assistant</p>
              </div>
            </div>
            <button
              type="button"
              onClick={closeChat}
              className="rounded-full p-1.5 text-gray-500 hover:bg-white/10 hover:text-white transition"
              aria-label="Close"
            >
              <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Messages */}
          <div className="relative flex-1 flex flex-col min-h-0">
            <div
              ref={listRef}
              className="flex-1 overflow-y-auto bg-[#14161A] scroll-smooth p-4 pb-6 space-y-3.5"
            >
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[90%] rounded-2xl px-3.5 py-2.5 text-xs sm:text-sm whitespace-pre-wrap ${
                    m.role === "user"
                      ? "bg-[var(--carysil-red)] text-white shadow-lg shadow-[var(--carysil-red)]/40"
                      : "bg-[#2c2d31] text-gray-100 border border-white/5 shadow-md"
                  }`}
                >
                  {m.content}
                  {m.role === "assistant" && m.dealers && m.dealers.length > 0 && (
                    <div className="mt-2.5 space-y-2">
                      {m.dealers.slice(0, 6).map((dealer) => (
                        <div
                          key={dealer.id}
                          className="rounded-lg border border-white/5 bg-[#14161A] text-black p-3 text-left"
                        >
                          <p className="font-medium text-gray-100 text-xs sm:text-sm">{dealer.name}</p>
                          <p className="text-[11px] text-gray-400 mt-0.5 sm:text-xs">{dealer.city}, {dealer.state}</p>
                          <p className="text-[11px] text-gray-300 mt-1 sm:text-xs">{dealer.phone}</p>
                          <a
                            href={`mailto:${dealer.contact_email}`}
                            className="text-[11px] text-[var(--carysil-red)] font-medium hover:underline sm:text-xs"
                          >
                            {dealer.contact_email}
                          </a>
                        </div>
                      ))}
                    </div>
                  )}
                  {m.role === "assistant" && m.recommendations && m.recommendations.length > 0 && (
                    <div className="mt-2.5 space-y-2">
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
                              className="h-12 w-12 shrink-0 rounded-md object-cover bg-black/40"
                            />
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="font-medium text-gray-100 text-xs sm:text-sm line-clamp-2">{rec.name}</p>
                            {rec.price && <p className="mt-0.5 text-xs text-gray-400">{rec.price}</p>}
                            <span className="text-xs text-[var(--carysil-red)] font-medium">View →</span>
                          </div>
                        </a>
                      ))}
                    </div>
                  )}
                  {m.role === "assistant" && m.followups && m.followups.length > 0 && (
                    <div className="mt-2.5 flex flex-col gap-2">
                      {m.followups.map((q) => (
                        <div
                          key={q}
                          className="rounded-2xl border border-[var(--carysil-red)]/70 bg-transparent px-3.5 py-2.5 text-xs sm:text-sm text-gray-100"
                        >
                          {q}
                        </div>
                      ))}
                    </div>
                  )}
                  {m.role === "assistant" && m.meta?.error === "quota_exceeded" && (
                    <p className="mt-2 text-xs sm:text-sm text-red-600">Service temporarily limited. Please try again later.</p>
                  )}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className="max-w-[90%] rounded-2xl border border-white/5 bg-[#181a21] px-3.5 py-2.5 shadow-sm">
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
                onClick={() => scrollChatToBottom("smooth")}
                className="absolute bottom-3.5 left-1/2 -translate-x-1/2 z-20 flex h-10 w-10 items-center justify-center rounded-full border-2 border-gray-300 bg-[#2a2a2e] text-white shadow-[0_4px_20px_rgba(0,0,0,0.5)] ring-2 ring-black/20 hover:bg-[#35353a] hover:border-gray-200 transition"
                aria-label="Scroll to latest messages"
              >
                <svg
                  className="h-[18px] w-[18px]"
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
            className="border-t border-white/5 bg-[#14161A] px-4 py-3.5"
          >
            <div className="flex items-end">
              <div className="flex w-full items-end gap-2 rounded-2xl border border-white/20 bg-[#14161A] px-3.5 py-2.5 shadow-[0_2px_8px_rgba(0,0,0,0.4)] focus-within:border-[var(--carysil-red)] focus-within:ring-1 focus-within:ring-[var(--carysil-red)] focus-within:shadow-[0_0_0_3px_rgba(220,38,38,0.15)] transition">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (canSend) void send(input);
                    }
                  }}
                  placeholder="Message..."
                  rows={1}
                  className="min-h-10 max-h-48 flex-1 resize-none overflow-y-auto whitespace-pre-wrap break-words bg-transparent border-none py-2 text-xs leading-[1.45] text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-0 sm:text-sm sm:leading-5"
                />
                <button
                  type="submit"
                  disabled={!canSend}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--carysil-red)] text-white shadow-md shadow-[var(--carysil-red)]/40 hover:opacity-90 disabled:opacity-40 transition"
                >
                  <svg
                    className="h-[18px] w-[18px]"
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
            <p className="mt-2 flex items-center justify-center gap-2 text-center text-[11px] text-gray-500 sm:text-xs">
              <img
                src="/favicon.webp"
                alt="Carysil logo"
                className="h-3.5 w-3.5 rounded-sm sm:h-4 sm:w-4"
              />
              <span>Powered by Carysil</span>
            </p>
          </form>
        </div>
      )}
    </>
  );
}
