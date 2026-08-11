import { searchDocuments, type DocumentMatch } from "@/lib/documentSearch";
import { callAIJson } from "@/lib/ai";
import { getPrompt } from "@/lib/prompts";

export type InstallationAnswer = {
  message: string;
  sources: Array<{ title: string; url: string | null }>;
  /** True when we found and answered from real FAQ content; false when we escalated instead of guessing. */
  matched: boolean;
  followups: string[];
};

/**
 * A match this close to the query is treated as directly answering it.
 * Below RELATED_MATCH_THRESHOLD we don't trust the content enough to
 * reference it at all — installation guidance is the one area where a
 * plausible-sounding wrong answer is worse than admitting we don't know.
 */
const STRONG_MATCH_THRESHOLD = 0.5;
const RELATED_MATCH_THRESHOLD = 0.38;

/** FAQ answers that defer to a manual/installer without actionable steps. */
const VAGUE_CONTENT_PATTERN =
  /\b(refer to (the )?(product('s)? |specific )?manual|consult.*(installer|professional)|varies by model|check the product-specific|always refer to the manual|speak to a professional installer)\b/i;

/** Keep installation grounding on install/care topics — not dealer/buy FAQs that can rank high on brand keywords. */
const INSTALL_TOPIC_PATTERN =
  /\b(install|installation|mount|undermount|top\s*mount|fit|fitting|cut[\s-]?out|troubleshoot|warranty|seal|care|clean)\b/i;

type AiAnswer = { answer: string; used_sources: number[] };

function buildSources(matches: DocumentMatch[]): Array<{ title: string; url: string | null }> {
  return matches.map((m) => ({ title: m.title, url: m.url }));
}

function isVagueContent(match: DocumentMatch): boolean {
  return VAGUE_CONTENT_PATTERN.test(match.content);
}

function isInstallTopic(match: DocumentMatch): boolean {
  return INSTALL_TOPIC_PATTERN.test(match.title) || INSTALL_TOPIC_PATTERN.test(match.content);
}

/** No LLM call available/succeeded — fall back to the verbatim retrieved FAQ text so the answer can never be ungrounded. */
function buildDeterministicAnswer(top: DocumentMatch, related: DocumentMatch[]): string {
  const lines = [top.content];
  if (related.length > 0) {
    lines.push(`\nYou might also want to check: ${related.map((d) => `"${d.title}"`).join(", ")}.`);
  }
  return lines.join("\n");
}

function buildEscalationMessage(category: string | null): string {
  const productLabel = category ? category.toLowerCase() : "that";
  return `I don't have confirmed guidance for ${productLabel} in our support library yet, and I'd rather not guess on installation steps. Could you share your city and phone number so a Carysil dealer or support partner can help directly?`;
}

/**
 * Ask the LLM to phrase a warm answer strictly from the retrieved FAQ content
 * (prompts/registry.json:installation_support forbids adding new facts). Falls
 * back to the deterministic verbatim template whenever the AI is unavailable,
 * fails, or returns an empty answer — the response is always either
 * AI-phrased-but-source-constrained or literally the source text, never
 * free-form invention.
 */
async function buildGroundedAnswer(
  message: string,
  relevant: DocumentMatch[]
): Promise<{ text: string; usedMatches: DocumentMatch[] }> {
  const context = relevant
    .map((m, i) => `[${i + 1}] Q: ${m.title}\nA: ${m.content}`)
    .join("\n\n");

  const { data, aiUsed } = await callAIJson<AiAnswer>(
    getPrompt("installation_support"),
    `User question: ${message}\n\nRetrieved Carysil FAQ context:\n${context}\n\nRespond with JSON.`,
    { answer: "", used_sources: [] }
  );

  const answer = (data.answer ?? "").trim();
  if (!aiUsed || !answer) {
    const [top, ...related] = relevant;
    return { text: buildDeterministicAnswer(top, related.slice(0, 2)), usedMatches: relevant.slice(0, 1) };
  }

  const usedIndices = Array.isArray(data.used_sources) ? data.used_sources : [];
  const usedMatches = usedIndices
    .map((i) => relevant[i - 1])
    .filter((m): m is DocumentMatch => Boolean(m));

  return { text: answer, usedMatches: usedMatches.length > 0 ? usedMatches : relevant.slice(0, 1) };
}

export async function answerInstallationQuery(
  message: string,
  category: string | null
): Promise<InstallationAnswer> {
  // Search the user question as-is. Prefixing with catalogue category labels
  // like "Sink — …" poisons the embedding and ranks unrelated FAQs above the hit.
  const matches = await searchDocuments(message, { limit: 4, documentTypes: ["faq", "guide"] });
  const scoreRelevant = matches.filter((m) => m.similarity >= RELATED_MATCH_THRESHOLD);
  // Drop "refer to the manual" style hits — they look related but are not actionable.
  const concrete = scoreRelevant.filter((m) => !isVagueContent(m));
  const topical = concrete.filter(isInstallTopic);
  const relevant = topical.length > 0 ? topical : concrete;

  if (relevant.length === 0) {
    return {
      message: buildEscalationMessage(category),
      sources: [],
      matched: false,
      followups: ["Share my city and phone", "Ask a different question", "Explore products"],
    };
  }

  const strongMatches = relevant.filter((m) => m.similarity >= STRONG_MATCH_THRESHOLD);
  if (strongMatches.length === 0) {
    // Related-only hits are too easy to mis-associate across product lines
    // (e.g. dishwasher cutout → quartz sink mounting FAQ). Escalate rather
    // than dumping weakly related entries.
    return {
      message: buildEscalationMessage(category),
      sources: [],
      matched: false,
      followups: ["Share my city and phone", "Ask a different question", "Explore products"],
    };
  }

  const { text, usedMatches } = await buildGroundedAnswer(message, strongMatches);
  // If the model (correctly) admits the FAQs don't answer the question, escalate
  // rather than returning a non-answer with "ask another installation" chips.
  if (
    /\b(do not|don't|do\s+not)\s+have confirmed\b/i.test(text) ||
    /\b(does not|doesn't)\s+(specify|include|cover|contain)\b/i.test(text) ||
    /\bno confirmed guidance\b/i.test(text)
  ) {
    return {
      message: buildEscalationMessage(category),
      sources: [],
      matched: false,
      followups: ["Share my city and phone", "Ask a different question", "Explore products"],
    };
  }
  return {
    message: text,
    sources: buildSources(usedMatches),
    matched: true,
    followups: ["Ask another installation question", "Talk to a Carysil dealer", "Explore products"],
  };
}
