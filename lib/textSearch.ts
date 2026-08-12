/**
 * Shared helpers for Postgres full-text search (`to_tsquery('simple', ...)`).
 * The 'simple' text search config does no stopword removal or stemming, so an
 * OR-joined query built from raw tokens ("what | is | the | price | of | the
 * | blender") matches almost every row in a small catalogue purely on
 * "the"/"of"/"is" — verified against this project's data: such a query
 * matched 586/586 products. Stripping common English stopwords before
 * building the tsquery keeps FTS anchored to the words that actually carry
 * meaning.
 */

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "of", "in", "on", "at", "to", "for", "with", "and", "or", "do", "does",
  "did", "what", "which", "who", "whom", "this", "that", "these", "those",
  "i", "you", "he", "she", "it", "we", "they", "my", "your", "his", "her",
  "its", "our", "their", "have", "has", "had", "can", "could", "will",
  "would", "should", "may", "might", "must", "not", "no", "so", "if",
  "then", "than", "as", "by", "from", "about", "into", "up", "down",
  "out", "off", "over", "under", "again", "further", "once", "here",
  "there", "when", "where", "why", "how", "all", "any", "both", "each",
  "few", "more", "most", "other", "some", "such", "only", "own", "same",
  "too", "very", "just", "don", "now", "me", "us", "am",
]);

/**
 * Builds an OR-joined `to_tsquery('simple', ...)` string from meaningful
 * tokens only. Returns "" when nothing meaningful remains (pure stopwords /
 * punctuation) so callers can skip the FTS branch instead of matching
 * everything.
 */
export function buildTsQuery(text: string): string {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  return Array.from(new Set(tokens)).join(" | ");
}

/**
 * Maps Postgres ts_rank into a 0-1 score comparable to cosine similarity, so
 * FTS hits can be ranked/thresholded alongside vector hits instead of being
 * treated as an unscored (or worse, hardcoded-0) tier. Typical ts_rank
 * values for a real keyword hit land ~0.05-0.4 on this schema.
 */
export function ftsRankToSimilarity(rank: number): number {
  if (!Number.isFinite(rank) || rank <= 0) return 0;
  return Math.min(0.95, Math.max(0, rank * 2.5));
}
