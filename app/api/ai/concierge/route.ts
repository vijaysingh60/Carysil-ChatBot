import { NextResponse } from "next/server";
import productsData from "@/data/products.json";
import dealersData from "@/data/dealers.json";
import { callAI } from "@/lib/ai";
import { detectIntent, type IntentResult } from "@/lib/concierge";

type Dealer = {
  id: string;
  name: string;
  city: string;
  state: string;
  products_supported: string[];
  contact_email: string;
  phone: string;
};

const allDealers = dealersData as Dealer[];

/** Normalize location string for fuzzy match (e.g. Bengaluru → bangalore, NCR → delhi/gurgaon/noida) */
function normalizeLoc(s: string): string {
  const lower = s.toLowerCase().trim();
  const map: Record<string, string> = {
    bangalore: "bangalore",
    bengaluru: "bangalore",
    bombay: "mumbai",
    gurgaon: "gurgaon",
    gurugram: "gurgaon",
    ncr: "gurgaon",
    delhi: "delhi",
    "new delhi": "new delhi",
    noida: "noida",
    chennai: "chennai",
    madras: "chennai",
    kolkata: "kolkata",
    calcutta: "kolkata",
  };
  return map[lower] ?? lower;
}

function filterDealersByLocation(location: { city?: string; state?: string }): Dealer[] {
  if (!location.city && !location.state) return [];
  const cityNorm = location.city ? normalizeLoc(location.city) : "";
  const stateNorm = location.state ? normalizeLoc(location.state) : "";
  return allDealers.filter((d) => {
    const dCity = normalizeLoc(d.city);
    const dState = normalizeLoc(d.state);
    const matchCity = cityNorm && (dCity.includes(cityNorm) || cityNorm.includes(dCity));
    const matchState = stateNorm && (dState.includes(stateNorm) || stateNorm.includes(dState));
    if (location.city && location.state) return matchCity || matchState;
    if (location.city) return matchCity;
    return matchState;
  });
}

function formatLocation(loc: { city?: string; state?: string }): string {
  if (loc.city && loc.state) return `${loc.city}, ${loc.state}`;
  return loc.city || loc.state || "";
}

type Product = {
  id: string;
  name: string;
  category: string;
  style: string;
  material: string;
  price_range: string;
  description: string;
  price?: string;
  image_url?: string;
  url?: string;
  collection?: string;
};

const allProducts = productsData as Product[];
const productById = new Map(allProducts.map((p) => [p.id, p]));

/** Filter products by intent: categories and optional material/price_range/style */
function filterByIntent(
  intent: IntentResult
): Product[] {
  if (!intent.categories?.length) {
    return allProducts;
  }
  const set = new Set(intent.categories as string[]);
  let list = allProducts.filter((p) => set.has(p.category));
  const f = intent.filters;
  if (f?.material) {
    const m = f.material.toLowerCase();
    list = list.filter(
      (p) => p.material?.toLowerCase().includes(m) || m.split(/\s+/).some((w) => p.material?.toLowerCase().includes(w))
    );
  }
  if (f?.price_range) {
    const pr = f.price_range.toLowerCase();
    list = list.filter(
      (p) => p.price_range?.toLowerCase() === pr || p.price_range?.toLowerCase().includes(pr)
    );
  }
  if (f?.style) {
    const s = f.style.toLowerCase();
    list = list.filter(
      (p) => p.style?.toLowerCase().includes(s) || s.split(/\s+/).some((w) => p.style?.toLowerCase().includes(w))
    );
  }
  return list.length > 0 ? list : allProducts.filter((p) => set.has(p.category));
}

const RECOMMENDATION_SYSTEM = `You are the Carysil product recommendation assistant for Carysil (carysil.com), a premium kitchen and bathroom brand.

You will receive:
1. The user's message
2. The product category/categories they are interested in
3. A RELEVANT catalogue (already filtered to match their intent). Recommend ONLY from this catalogue.

**Your tasks:**
1. If the catalogue is empty or you have no good matches, say so briefly and suggest they refine (e.g. different budget or material). Set recommended_ids to [].
2. Otherwise, pick 3–4 products that best match the user's stated or implied needs (budget, material, style, size, use case). Use ONLY the "id" values from the catalogue (exact match). Aim for at least 3 recommendations when the catalogue has enough options.
3. Prefer variety: different series, sizes, or colours where relevant.
4. Provide a short, clear "reasoning" (2–4 sentences) explaining WHY you chose these products for this user. This will be shown to build trust (e.g. "We picked these quartz sinks because you asked for a modern look and medium budget; they offer single and double bowl options and fit under ₹15k.").

**Response format – strict JSON only (no markdown, no backticks):**
{
  "asking_clarification": false,
  "message": "Your friendly reply with a brief intro, then you can mention the products below.",
  "recommended_ids": ["id1", "id2", "id3", "id4"],
  "reasoning": "Short explanation of why these products fit the user's need."
}

- "message": Plain text, user-facing. Keep it concise and warm.
- "reasoning": Internal-style explanation for why these picks; can be shown to the user as "Why we chose these."
- Use only ids that appear in the catalogue you were given.`;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const message = String(body?.message || "").trim();
    if (!message) {
      return NextResponse.json(
        { error: "Missing message" },
        { status: 400 }
      );
    }

    // Step 1: Detect intent (categories + optional clarification)
    const intent = await detectIntent(message);

    if (intent.asking_clarification && intent.clarification_message) {
      return NextResponse.json({
        result: intent.clarification_message,
        recommendations: [],
        dealers: [],
        reasoning: null,
        aiUsed: true,
        error: undefined,
      });
    }

    // Step 2: Dealer intent — filter dealers by location and return
    if (intent.dealer_intent && intent.location && (intent.location.city || intent.location.state)) {
      const dealers = filterDealersByLocation(intent.location);
      const locationLabel = formatLocation(intent.location);
      const resultMessage =
        dealers.length > 0
          ? `Here are Carysil dealers in ${locationLabel}. You can call or email them for availability and pricing.`
          : `We don't have a listed dealer in ${locationLabel} yet. Try a nearby city or contact us at carysil.com/reach-us.`;
      return NextResponse.json({
        result: resultMessage,
        recommendations: [],
        dealers: dealers.slice(0, 10),
        reasoning: null,
        aiUsed: true,
        error: undefined,
      });
    }

    // Step 3: Filter catalogue to relevant products only
    const relevantProducts = filterByIntent(intent);
    const catalogueSummary = relevantProducts.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      style: p.style,
      material: p.material,
      price_range: p.price_range,
      price: p.price,
      description: p.description?.slice(0, 120),
    }));

    const placeholderJson = JSON.stringify(
      {
        asking_clarification: false,
        message:
          "Here are some products that might work for you. If you share your budget or style, I can narrow it down further.",
        recommended_ids: [] as string[],
        reasoning: "No specific reasoning — please refine your request.",
      },
      null,
      2
    );

    const categoryLabel =
      intent.categories?.length > 0
        ? intent.categories.join(", ")
        : "various";

    const { text, aiUsed, error } = await callAI(
      RECOMMENDATION_SYSTEM,
      `User message:\n${message}\n\nDetected category/categories of interest: ${categoryLabel}.\n\nRelevant catalogue (recommend only from these ids):\n${JSON.stringify(catalogueSummary, null, 2)}\n\nRespond with JSON only.`,
      placeholderJson
    );

    type ConciergeResponse = {
      asking_clarification?: boolean;
      message?: string;
      recommended_ids?: string[];
      reasoning?: string;
    };

    let parsed: ConciergeResponse | null = null;
    const raw = text.replace(/```json?\s*|\s*```/g, "").trim();
    try {
      parsed = JSON.parse(raw) as ConciergeResponse;
    } catch {
      parsed = null;
    }

    const fallbackMessage = aiUsed ? text : "Here are some options that might suit you.";
    let result: ConciergeResponse;
    if (!parsed) {
      result = {
        asking_clarification: false,
        message: fallbackMessage,
        recommended_ids: [],
        reasoning: undefined,
      };
    } else if (!parsed.message) {
      result = {
        ...parsed,
        message: fallbackMessage,
      };
    } else {
      result = parsed;
    }
    const recommendedIds = Array.isArray(result.recommended_ids)
      ? result.recommended_ids
      : [];
    const recommendations = recommendedIds
      .map((id) => {
        const p = productById.get(id);
        if (!p) return null;
        return {
          id: p.id,
          name: p.name,
          price: p.price,
          image_url: p.image_url,
          url: p.url,
          description: p.description,
        };
      })
      .filter(Boolean);

    return NextResponse.json({
      result: result.message || "",
      recommendations,
      dealers: [],
      reasoning: result.reasoning ?? null,
      aiUsed,
      error,
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: "Failed to process message" },
      { status: 500 }
    );
  }
}
