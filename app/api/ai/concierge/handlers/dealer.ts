import dealersData from "@/data/dealers.json";

export type Dealer = {
  id: string;
  name: string;
  city: string;
  state: string;
  products_supported: string[];
  contact_email: string;
  phone: string;
};

export const allDealers = dealersData as Dealer[];

export function normalizeLoc(s: string): string {
  const lower = s.toLowerCase().trim();
  const map: Record<string, string> = {
    bangalore: "bangalore",
    bengaluru: "bangalore",
    bombay: "mumbai",
    gurgaon: "gurgaon",
    gurugram: "gurgaon",
    ncr: "gurgaon",
    "delhi ncr": "ncr",
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

export const knownDealerStates = new Set(allDealers.map((d) => normalizeLoc(d.state)));

function locationAliases(s: string): string[] {
  const normalized = normalizeLoc(s);
  if (normalized === "ncr") {
    return ["gurgaon", "noida", "new delhi", "delhi", "faridabad", "ghaziabad", "dwarka"];
  }
  return [normalized];
}

function locationMatches(candidate: string, search: string): boolean {
  return locationAliases(search).some((alias) => {
    const normalizedCandidate = normalizeLoc(candidate);
    return normalizedCandidate.includes(alias) || alias.includes(normalizedCandidate);
  });
}

export function filterDealersByLocation(location: { city?: string; state?: string }): Dealer[] {
  if (!location.city && !location.state) return [];
  return allDealers.filter((d) => {
    const matchCity = location.city ? locationMatches(d.city, location.city) : false;
    const matchState = location.state ? locationMatches(d.state, location.state) : false;
    if (location.city && location.state) return matchCity || matchState;
    if (location.city) return matchCity;
    return matchState;
  });
}

/**
 * Picks the single dealer to route a lead to from an already location-filtered
 * list. Prefers a dealer whose products_supported covers the user's product
 * category, but never re-ranks by location — filterDealersByLocation already
 * narrowed that. Deterministic (first match) rather than randomized so the
 * same lead context always routes the same way.
 */
export function pickBestDealer(dealers: Dealer[], category?: string | null): Dealer | null {
  if (dealers.length === 0) return null;
  if (category) {
    const normalizedCategory = category.toLowerCase();
    const categoryMatch = dealers.find((d) =>
      d.products_supported?.some((p) => p.toLowerCase().includes(normalizedCategory))
    );
    if (categoryMatch) return categoryMatch;
  }
  return dealers[0];
}

export function formatLocation(loc: { city?: string; state?: string }): string {
  if (loc.city && loc.state) return `${loc.city}, ${loc.state}`;
  return loc.city || loc.state || "";
}

export function dealerFollowupQuestion(input: {
  dealerCount: number;
  cityShort: string | null;
  locationLabel: string;
  allIndia?: boolean;
}): string {
  if (input.allIndia) {
    return "Would you like help shortlisting sinks, faucets, or appliances before you contact a dealer?";
  }
  if (input.dealerCount > 0) {
    const place = input.cityShort?.trim() || input.locationLabel.trim();
    return place
      ? `Would you like tailored Carysil product suggestions to discuss when you reach out in ${place}?`
      : "Would you like tailored Carysil product suggestions to discuss when you reach out to a dealer?";
  }
  return "Would you like tailored Carysil product ideas from our catalogue for your kitchen or bathroom?";
}

export function inferDealerLocationFromMessage(
  message: string,
  notACityPattern: RegExp
): { city?: string; state?: string } | null {
  if (notACityPattern.test(message)) return null;
  const nearMeMatch = message.match(/\bnear\s+me\s+(?:in|at|around)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+){0,2})\b/i);
  const match = nearMeMatch || message.match(/\b(?:in|at|from|near)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+){0,2})\b/i);
  if (!match) return null;
  const location = toTitleCaseLocation(match[1]);
  if (notACityPattern.test(location)) return null;
  const normalized = normalizeLoc(location);
  if (knownDealerStates.has(normalized)) {
    return { state: location };
  }
  return { city: location };
}

function toTitleCaseLocation(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
