import { getDbPool } from "@/lib/db";
import { searchDocuments, type DocumentMatch } from "@/lib/documentSearch";
import { callAIJson } from "@/lib/ai";
import { getPrompt } from "@/lib/prompts";

export type ArchitectAnswer = {
  message: string;
  sources: Array<{ title: string; url: string | null }>;
  followups: string[];
};

type SpecRow = {
  id: string;
  name: string;
  category: string;
  material: string | null;
  size: string | null;
  description: string | null;
  url: string | null;
  features: string[] | null;
  specifications: Record<string, unknown> | null;
};

const SPEC_JSON_KEYS_TO_SKIP = new Set(["collections", "sources", "scraped_at", "price_range", "compare_at_price"]);

/** Same grounding floors as handlers/installation.ts — weak doc hits must not invent specs. */
const STRONG_MATCH_THRESHOLD = 0.5;
const RELATED_MATCH_THRESHOLD = 0.38;

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "for",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "is",
  "are",
  "what",
  "which",
  "with",
  "from",
  "need",
  "please",
  "can",
  "you",
  "me",
  "my",
  "our",
  "project",
  "client",
  "architect",
  "designer",
  "contractor",
  "spec",
  "specs",
  "specification",
  "specifications",
]);

function tokenizeQuery(message: string): string[] {
  return message
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

function scoreSpecRow(row: SpecRow, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const haystack = [
    row.name,
    row.material,
    row.size,
    row.description,
    JSON.stringify(row.specifications ?? {}),
    (row.features ?? []).join(" "),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  let hits = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) hits += 1;
  }
  return hits / tokens.length;
}

/**
 * Rank active products in the stated categories by overlap with the professional's
 * question (name/material/size/description/specs) so we don't dump an arbitrary
 * first-N category slice.
 */
async function fetchProductSpecs(message: string, categories: string[], limit = 6): Promise<SpecRow[]> {
  if (categories.length === 0) return [];
  const pool = getDbPool();
  const { rows } = await pool.query<SpecRow>(
    `SELECT id, name, category, material, size, description, url, features, specifications
     FROM products
     WHERE is_active = true AND category = ANY($1::text[])
     LIMIT 80`,
    [categories]
  );

  const tokens = tokenizeQuery(message);
  if (tokens.length === 0) return rows.slice(0, limit);

  return [...rows]
    .map((row) => ({ row, score: scoreSpecRow(row, tokens) }))
    .sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name))
    .filter((entry, index) => entry.score > 0 || index < 3)
    .slice(0, limit)
    .map((entry) => entry.row);
}

function formatSpecRow(row: SpecRow): string {
  const specs = row.specifications ?? {};
  const specLines = Object.entries(specs)
    .filter(([key, value]) => !SPEC_JSON_KEYS_TO_SKIP.has(key) && value != null && value !== "")
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
  const parts = [
    `Product: ${row.name} (${row.category})`,
    row.material ? `Material: ${row.material}` : null,
    row.size ? `Size: ${row.size}` : null,
    ...specLines,
    ...(row.features ?? []),
  ].filter(Boolean);
  return parts.join("\n");
}

function gateDocumentMatches(matches: DocumentMatch[]): DocumentMatch[] {
  return matches.filter((m) => m.similarity >= RELATED_MATCH_THRESHOLD);
}

/**
 * Technical, spec-first answer for the architect/designer/contractor persona
 * (see resolvePersona in services/conversationStateService.ts). Grounds on the
 * products table's specifications/features JSONB (already populated by the
 * scraping pipeline) plus any spec_sheet/brochure documents — same
 * "answer only from retrieved content, escalate rather than guess"
 * discipline as handlers/installation.ts, since a wrong technical figure can
 * fail a project submission just as badly as a wrong installation step.
 */
export async function answerArchitectQuery(
  message: string,
  categories: string[]
): Promise<ArchitectAnswer> {
  const [specRows, rawDocMatches] = await Promise.all([
    fetchProductSpecs(message, categories),
    searchDocuments(message, { limit: 3, documentTypes: ["spec_sheet", "brochure", "faq"] }),
  ]);
  const docMatches = gateDocumentMatches(rawDocMatches);

  if (specRows.length === 0 && docMatches.length === 0) {
    return {
      message:
        "I don't have confirmed technical specifications for that yet. Could you share your city and phone number so a Carysil technical contact can send exact specs?",
      sources: [],
      followups: ["Share my city and phone", "Ask about a different product", "See product catalogue"],
    };
  }

  // Prefer stronger doc hits when present; still pass all gated docs to the LLM.
  const preferredDocs =
    docMatches.filter((m) => m.similarity >= STRONG_MATCH_THRESHOLD).length > 0
      ? docMatches.filter((m) => m.similarity >= STRONG_MATCH_THRESHOLD)
      : docMatches;

  const productContext = specRows.map(formatSpecRow).join("\n\n");
  const docContext = preferredDocs.map((d, i) => `[Doc ${i + 1}] ${d.title}\n${d.content}`).join("\n\n");

  const { data, aiUsed } = await callAIJson<{ answer: string }>(
    getPrompt("architect_assistant"),
    [
      `Professional's question: ${message}`,
      `\nRetrieved product specifications:\n${productContext || "(none)"}`,
      `\nRetrieved reference documents:\n${docContext || "(none)"}`,
      "\nRespond with JSON.",
    ].join("\n"),
    { answer: "" }
  );

  const answer = (data.answer ?? "").trim();
  const fallbackAnswer = specRows.length > 0 ? formatSpecRow(specRows[0]) : (preferredDocs[0]?.content ?? "");
  let message_ = aiUsed && answer ? answer : fallbackAnswer;

  // If the model admits the retrieved specs don't cover the ask (e.g. certifications),
  // escalate instead of padding with adjacent eco/marketing FAQ wording.
  if (
    /\b(does not|doesn't|do not|don't)\s+(specify|indicate|include|cover|contain|mention)\b/i.test(message_) ||
    /\bno (confirmed )?(technical )?specifications\b/i.test(message_) ||
    /\bnot (covered|present|available) in the (provided|retrieved)\b/i.test(message_)
  ) {
    return {
      message:
        "I don't have confirmed technical specifications for that yet. Could you share your city and phone number so a Carysil technical contact can send exact specs?",
      sources: [],
      followups: ["Share my city and phone", "Ask about a different product", "See product catalogue"],
    };
  }

  const sources = [
    ...specRows.slice(0, 3).map((row) => ({ title: row.name, url: row.url })),
    ...preferredDocs.slice(0, 2).map((doc) => ({ title: doc.title, url: doc.url })),
  ];

  return {
    message: message_,
    sources,
    followups: ["Ask about another product spec", "See the full catalogue PDF", "Talk to a Carysil dealer"],
  };
}
