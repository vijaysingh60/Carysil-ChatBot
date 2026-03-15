"use client";

import { useState } from "react";
import Link from "next/link";

const EXAMPLE_DESCRIPTION =
  "Luxury villa bathroom with black fittings and rain shower.";

export default function DesignAssistantPage() {
  const [description, setDescription] = useState("");
  const [result, setResult] = useState("");
  const [aiUsed, setAiUsed] = useState<boolean | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim()) return;
    setLoading(true);
    setResult("");
    setAiUsed(null);
    setError(undefined);
    try {
      const res = await fetch("/api/ai/design-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: description.trim() }),
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
        Architect Design Assistant
      </h1>
      <p className="mt-1 text-gray-600">
        Describe your project and get compatible Carysil product suggestions.
      </p>

      <form onSubmit={handleSubmit} className="mt-8 max-w-2xl">
        <label className="block text-sm font-medium text-carysil-stone mb-2">
          Project description
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Luxury villa bathroom with black fittings and rain shower."
          rows={4}
          className="w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-carysil-stone placeholder:text-gray-400 focus:border-carysil-red focus:outline-none focus:ring-1 focus:ring-carysil-red resize-y"
        />
        <button
          type="submit"
          disabled={loading}
          className="mt-4 rounded-lg bg-carysil-red px-4 py-3 font-medium text-white hover:bg-red-700 disabled:opacity-50"
        >
          {loading ? "Getting suggestions…" : "Get design suggestions"}
        </button>
      </form>

      <div className="mt-6 rounded-lg bg-gray-50 border border-gray-200 p-4">
        <p className="text-sm font-medium text-carysil-stone mb-2">
          Example prompt
        </p>
        <button
          type="button"
          onClick={() => setDescription(EXAMPLE_DESCRIPTION)}
          className="text-sm text-gray-600 hover:text-carysil-red text-left"
        >
          {EXAMPLE_DESCRIPTION}
        </button>
      </div>

      {result && (
        <div className="mt-8 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-carysil-stone">
              Recommended design setup
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
    </div>
  );
}
