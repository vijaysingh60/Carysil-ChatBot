"use client";

import { useState } from "react";
import Link from "next/link";

export default function DealerRoutingPage() {
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [productInterest, setProductInterest] = useState("");
  const [phone, setPhone] = useState("");
  const [result, setResult] = useState("");
  const [aiUsed, setAiUsed] = useState<boolean | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setResult("");
    setAiUsed(null);
    setError(undefined);
    try {
      const res = await fetch("/api/ai/dealer-routing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          city,
          productInterest,
          phone,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      setResult(data.result || "");
      setAiUsed(data.aiUsed ?? false);
      setError(data.error);
    } catch (err) {
      setResult("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <Link
        href="/"
        className="text-sm text-gray-600 hover:text-carysil-red mb-6 inline-block"
      >
        ← Dashboard
      </Link>
      <h1 className="text-2xl font-semibold text-carysil-stone">
        Dealer Lead Routing AI
      </h1>
      <p className="mt-1 text-gray-600">
        Submit your details and we’ll match you with the best Carysil dealer.
      </p>

      <form onSubmit={handleSubmit} className="mt-8 max-w-md space-y-5">
        <div>
          <label className="block text-sm font-medium text-carysil-stone mb-2">
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            className="w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-carysil-stone placeholder:text-gray-400 focus:border-carysil-red focus:outline-none focus:ring-1 focus:ring-carysil-red"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-carysil-stone mb-2">
            City
          </label>
          <input
            type="text"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder="e.g. Hyderabad, Mumbai"
            className="w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-carysil-stone placeholder:text-gray-400 focus:border-carysil-red focus:outline-none focus:ring-1 focus:ring-carysil-red"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-carysil-stone mb-2">
            Product interest
          </label>
          <input
            type="text"
            value={productInterest}
            onChange={(e) => setProductInterest(e.target.value)}
            placeholder="e.g. Kitchen sink, Rain shower"
            className="w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-carysil-stone placeholder:text-gray-400 focus:border-carysil-red focus:outline-none focus:ring-1 focus:ring-carysil-red"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-carysil-stone mb-2">
            Phone number
          </label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+91 XXXXX XXXXX"
            className="w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-carysil-stone placeholder:text-gray-400 focus:border-carysil-red focus:outline-none focus:ring-1 focus:ring-carysil-red"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-carysil-red px-4 py-3 font-medium text-white hover:bg-red-700 disabled:opacity-50"
        >
          {loading ? "Routing lead…" : "Submit & get dealer"}
        </button>
      </form>

      {result && (
        <div className="mt-8 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-carysil-stone">
              Lead assigned
            </h2>
            {aiUsed !== null && (
              <span
                className={`text-xs font-medium px-2 py-1 rounded ${
                  aiUsed
                    ? "bg-emerald-100 text-emerald-800"
                    : error === "quota_exceeded"
                      ? "bg-red-100 text-red-800"
                      : "bg-amber-100 text-amber-800"
                }`}
              >
                {aiUsed
                  ? "Live AI"
                  : error === "quota_exceeded"
                    ? "Quota exceeded"
                    : "Demo response"}
              </span>
            )}
          </div>
          <div className="prose prose-sm max-w-none text-gray-700 whitespace-pre-wrap">
            {result}
          </div>
          {error === "quota_exceeded" && (
            <p className="mt-4 text-sm text-red-600">
              OpenAI quota exceeded. Check billing at{" "}
              <a
                href="https://platform.openai.com/account/billing"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                platform.openai.com
              </a>
              .
            </p>
          )}
        </div>
      )}

      <div className="mt-8 rounded-lg bg-gray-50 border border-gray-200 p-4">
        <p className="text-sm font-medium text-carysil-stone mb-2">
          Example to try
        </p>
        <ul className="text-sm text-gray-600 space-y-1">
          <li>• City: Hyderabad, Interest: Kitchen sink and faucet</li>
          <li>• City: Mumbai, Interest: Bathroom shower and basin</li>
        </ul>
      </div>
    </div>
  );
}
