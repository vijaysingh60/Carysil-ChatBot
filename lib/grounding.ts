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
