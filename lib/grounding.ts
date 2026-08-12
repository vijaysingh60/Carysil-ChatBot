import type { SimilarProduct } from "@/lib/vectorSearch";

export type GroundedContext = {
  products: SimilarProduct[];
};

export type GroundingResult = {
  valid: boolean;
  issues: string[];
  safeResponse: string;
};

function extractPriceMentions(text: string): number[] {
  const matches = text.match(/(?:Rs\.?|₹)\s*([\d,]+)/g) ?? [];
  return matches
    .map((m) => parseInt(m.replace(/[^\d]/g, ""), 10))
    .filter((n) => !Number.isNaN(n));
}

function buildSafeResponse(products: SimilarProduct[]): string {
  if (products.length === 0) {
    return "I couldn't find matching products. Could you share more details about what you're looking for?";
  }
  const lines = products
    .slice(0, 4)
    .map((p) => `- **${p.name}** (${p.category})${p.price ? ` — ${p.price}` : ""}`);
  return `Based on our catalogue:\n${lines.join("\n")}`;
}

export function verifyGroundedResponse(
  aiResponse: string,
  context: GroundedContext
): GroundingResult {
  const issues: string[] = [];

  // Check that price mentions are plausible against retrieved products
  const priceMentions = extractPriceMentions(aiResponse);
  for (const price of priceMentions) {
    const valid = context.products.some((p) => {
      if (p.price) {
        const productPrice = parseInt(p.price.replace(/[^\d]/g, ""), 10);
        // Allow ±20% tolerance for display formatting differences
        if (!Number.isNaN(productPrice)) {
          return Math.abs(productPrice - price) / productPrice <= 0.2;
        }
      }
      return false;
    });
    if (!valid) {
      issues.push(`Price "₹${price.toLocaleString()}" not found in retrieved products`);
    }
  }

  const safeResponse =
    issues.length > 0 ? buildSafeResponse(context.products) : aiResponse;

  return { valid: issues.length === 0, issues, safeResponse };
}

/**
 * Generalized numeric-claim grounding for free-text answers (installation
 * support, architect/spec assistant) that — unlike the product-recommendation
 * "message" field — are allowed and expected to state real facts (dimensions,
 * suction rates, HP, warranty years, prices). Those handlers had NO grounding
 * check at all before this: they relied solely on prompt instructions plus a
 * regex that only catches the model *admitting* it doesn't know, not the
 * model confidently inventing a number. This catches numbers the model
 * states that don't appear anywhere in the retrieved context it was given —
 * a fabricated dimension, HP rating, or warranty-year figure never having a
 * source string to match against.
 *
 * Deliberately loose (substring match on normalized digit+unit tokens, not
 * exact-value verification) to avoid false positives on rephrased units
 * ("60 cm" vs "60cm") — the goal is to catch numbers pulled from nowhere,
 * not to grade formatting.
 */
const NUMERIC_CLAIM_PATTERN =
  /\b\d[\d,]*(?:\.\d+)?\s*(?:cm|mm|inch(?:es)?|in|kg|kgs|l|ltr|litres?|liters?|hp|watts?|w|m³\/hr|amp|amps|a|years?|yrs?|%)\b/gi;

function normalizeNumericToken(token: string): string {
  return token.toLowerCase().replace(/[\s,]/g, "");
}

export function verifyNumericClaimsGrounded(
  answer: string,
  contextText: string
): { valid: boolean; issues: string[] } {
  const claims = answer.match(NUMERIC_CLAIM_PATTERN) ?? [];
  if (claims.length === 0) return { valid: true, issues: [] };

  const normalizedContext = normalizeNumericToken(contextText);
  const issues: string[] = [];
  for (const claim of claims) {
    const normalizedClaim = normalizeNumericToken(claim);
    if (!normalizedContext.includes(normalizedClaim)) {
      issues.push(`Numeric claim "${claim.trim()}" not found in retrieved context`);
    }
  }
  return { valid: issues.length === 0, issues };
}
