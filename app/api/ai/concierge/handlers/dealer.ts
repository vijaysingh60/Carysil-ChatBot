import dealersData from "@/data/dealers.json";
import dealerGeoData from "@/data/dealerGeo.json";

export type Dealer = {
  id: string;
  name: string;
  city: string;
  state: string;
  products_supported: string[];
  contact_email: string;
  phone: string;
  /** Free-text street address from the dealer sheet; used for locality matching and shown on the card. */
  address?: string;
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

// ---------------------------------------------------------------------------
// Locality-aware dealer lookup
//
// The dealer list carries a free-text street address for most dealers (e.g.
// "55, 31/4, New Palasia, Indore, Madhya Pradesh 452001"). Matching used to
// stop at city/state, so "near Palasia in Indore" returned every Indore dealer
// in sheet order and the Palasia one was usually cut off by the 6-card limit.
// findDealers() resolves the city/state first (to scope the pool), then ranks
// the pool by how well each dealer's address matches whatever area/locality
// the user named. Everything here is deterministic — it does not depend on the
// LLM having extracted an "area" field.
// ---------------------------------------------------------------------------

/** Words that never describe a place: chat filler, dealer/shop words, product words. */
const NON_PLACE_WORDS = new Set([
  "a", "an", "the", "is", "are", "am", "was", "be", "do", "does", "did", "can", "could", "would", "will",
  "i", "im", "ive", "me", "my", "we", "our", "you", "your", "us", "it", "its", "there", "here", "this", "that",
  "to", "of", "for", "and", "or", "also", "any", "some", "all", "no", "not", "yes", "ok", "okay",
  "on", "with", "about", "by", "as", "if", "but", "so", "into", "than", "then", "just", "only", "like", "up", "out",
  "one", "ones", "place", "places", "them", "those", "these", "nearer", "closer", "closest", "yeah", "yep", "sure",
  "area", "areas", "locality", "town", "home", "house", "office", "address", "side",
  // location prepositions: a bare reply like "in hyderabad" reaches us as the city "In Hyderabad"
  "in", "at", "from", "near", "around", "within", "next", "close", "beside", "behind", "opposite", "opp",
  "show", "find", "get", "give", "list", "tell", "want", "need", "looking", "look", "search", "locate", "suggest",
  "help", "please", "pls", "kindly", "hi", "hello", "hey", "thanks", "thank", "which", "what", "where", "who", "how",
  "buy", "purchase", "order", "available", "availability", "contact", "details", "number", "info", "information",
  "price", "prices", "pricing", "cost", "live", "stay", "based", "located", "location", "city", "state", "india",
  "dealer", "dealers", "store", "stores", "shop", "shops", "showroom", "showrooms", "outlet", "outlets",
  "gallery", "galleries", "nearest", "closest", "nearby", "local", "carysil", "partner", "partners",
  "sink", "sinks", "faucet", "faucets", "tap", "taps", "hob", "hobs", "chimney", "chimneys", "dishwasher",
  "dishwashers", "disposer", "disposers", "appliance", "appliances", "accessory", "accessories", "kitchen",
  "bathroom", "bath", "product", "products",
  "matte", "matt", "black", "white", "chrome", "gold", "steel", "stainless", "quartz", "granite", "single",
  "double", "bowl", "modern", "budget", "premium", "luxury", "size", "under", "above", "cm", "inch",
]);

/** Words so common inside addresses that matching on them alone says nothing about the area. */
const GENERIC_ADDRESS_WORDS = new Set([
  "road", "rd", "street", "st", "marg", "lane", "gali", "path", "highway", "hwy", "nh", "main", "cross",
  "nagar", "colony", "chowk", "chauraha", "circle", "square", "market", "bazar", "bazaar", "complex",
  "building", "bldg", "floor", "shop", "plot", "society", "park", "tower", "towers", "plaza", "mall",
  "area", "sector", "phase", "block", "ward", "zone", "opp", "opposite", "near", "behind", "beside",
  "no", "dist", "district", "tal", "taluka", "city",
]);

/** Spelling variants of cities in the dealer list → the spelling the list uses. */
const CITY_ALIASES: Record<string, string> = {
  vadodara: "baroda",
  ahmednagar: "ahmadnagar",
  bhubaneshwar: "bhubaneswar",
  purnia: "purnea",
  calcutta: "kolkata",
  hoshangabad: "narmdapuram",
  narmadapuram: "narmdapuram",
  gurugram: "gurgaon",
};

/** Lowercase, drop dots ("M.P." → "mp"), turn every other symbol into a space. */
function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

type IndexedDealer = { dealer: Dealer; order: number; words: string[]; compact: string };

// Name is included because some rows only carry the locality there
// ("ANAND BIG MALL, RATLAM"). Built once at module load (~1.1k rows).
const dealerIndex: IndexedDealer[] = allDealers.map((dealer, order) => {
  const text = normText(`${dealer.address ?? ""} ${dealer.name}`);
  return { dealer, order, words: text.split(" ").filter(Boolean), compact: text.replace(/ /g, "") };
});

const cityNames = new Map<string, string>(); // normalized city → display city
const stateNames = new Map<string, string>(); // normalized state → display state
for (const d of allDealers) {
  cityNames.set(normText(d.city), d.city);
  stateNames.set(normText(d.state), d.state);
}

type LatLon = [number, number];

// Coordinates for every dealer city, plus well-known places with NO dealers.
// Built by scripts/buildDealerGeo.mjs — re-run it when the dealer list gains cities.
const dealerGeo = dealerGeoData as unknown as {
  served: Record<string, LatLon>; // "City|State" → [lat, lon]
  unserved: Record<string, LatLon | null>; // lowercase place name → [lat, lon]
};

/**
 * Well-known Indian cities/states that are NOT in the dealer list. Without this,
 * "dealers in Hyderabad near Madhapur" can't tell that Hyderabad is a real city
 * we don't cover, and would instead go hunting for "madhapur" in every address in
 * the country (and find Madhapar, Rajkot). Naming one of these means "no dealers
 * here" — never "search elsewhere". Anything the list does cover wins over it.
 */
const unservedNames = new Map<string, string>(); // normalized → display
const unservedCoords = new Map<string, LatLon>(); // display → coordinates
for (const [raw, coord] of Object.entries(dealerGeo.unserved)) {
  const key = normText(raw);
  if (cityNames.has(key) || stateNames.has(key)) continue;
  const display = key.replace(/\b\w/g, (c) => c.toUpperCase());
  unservedNames.set(key, display);
  if (coord) unservedCoords.set(display, coord);
}

/** One entry per dealer city that has coordinates, for "nearest dealers" lookups. */
const servedCityPoints: { city: string; coord: LatLon; dealers: Dealer[] }[] = [];
{
  const byKey = new Map<string, Dealer[]>();
  for (const d of allDealers) {
    const key = `${d.city}|${d.state}`;
    byKey.set(key, [...(byKey.get(key) ?? []), d]);
  }
  byKey.forEach((dealers, key) => {
    const coord = dealerGeo.served[key];
    if (coord) servedCityPoints.push({ city: key.split("|")[0], coord, dealers });
  });
}

function haversineKm(a: LatLon, b: LatLon): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export type NearbyCity = { city: string; km: number };

/**
 * The dealer cities closest to a point, straight-line distance rounded to the nearest 10 km.
 * Suggestions are spread out: real dealer hubs (3+ dealers) come first, and a town right next to one
 * already chosen is skipped — otherwise "nearest to Mumbai" would be Manchar, Pune and Junnar, which
 * is one place listed three times.
 */
function nearestDealerCities(from: LatLon, limit = 3): NearbyCity[] {
  const ranked = servedCityPoints
    .map((p) => ({ p, km: haversineKm(from, p.coord) }))
    .sort((a, b) => a.km - b.km);
  const picked: typeof ranked = [];
  const take = (minDealers: number) => {
    for (const r of ranked) {
      if (picked.length >= limit) return;
      if (r.p.dealers.length < minDealers) continue;
      if (picked.some((q) => haversineKm(q.p.coord, r.p.coord) < 60)) continue; // already covered by a pick
      // Towns within 60 km of each other are one place to the customer: name the one with the most dealers
      // (Kolhapur, not the slightly-nearer Ichalkaranji).
      const cluster = ranked.filter(
        (c) =>
          c.p.dealers.length >= minDealers &&
          haversineKm(c.p.coord, r.p.coord) < 60 &&
          !picked.some((q) => haversineKm(q.p.coord, c.p.coord) < 60)
      );
      picked.push(cluster.reduce((best, c) => (c.p.dealers.length > best.p.dealers.length ? c : best), r));
    }
  };
  take(3); // established dealer hubs first
  take(1); // then smaller towns, only if the area is thin
  return picked
    .map(({ p, km }) => ({ city: p.city, km: Math.round(km / 10) * 10 }))
    .sort((a, b) => a.km - b.km);
}

/** "Gujarat, Maharashtra, …" — the states the dealer list covers, most dealers first. */
export function dealerCoverageSummary(): string {
  const counts = new Map<string, number>();
  for (const d of allDealers) counts.set(d.state, (counts.get(d.state) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([s]) => (s.startsWith("Dadra") ? "Dadra & Nagar Haveli" : s))
    .join(", ");
}

/** Longest city/state name starting at tokens[start], so "cooch behar" beats "cooch". */
function matchNameAt(
  tokens: string[],
  start: number,
  names: Map<string, string>,
  aliases: Record<string, string> = {}
): { display: string; length: number } | null {
  for (let len = Math.min(4, tokens.length - start); len >= 1; len--) {
    const phrase = tokens.slice(start, start + len).join(" ");
    const display = names.get(aliases[phrase] ?? phrase);
    if (display) return { display, length: len };
  }
  return null;
}

/** Splits free text into the pieces that can name a place; drops the "I want a sink dealer" lead-in. */
function locationPieces(message: string, location?: { city?: string; state?: string }): string[] {
  const pieces: string[] = [];
  const clauses = message.toLowerCase().replace(/\./g, "").split(/[,;?!\n]+/);
  for (const clause of clauses) {
    const parts = clause.split(/\b(?:near|nearby|around|close to|next to|in|at|from|beside|opposite|opp|behind|within)\b/);
    // parts[0] precedes any location preposition (chat filler); only keep it for a bare "old palasia" style clause.
    if (parts.length > 1) pieces.push(...parts.slice(1));
    else pieces.push(parts[0]);
  }
  // The intent step often stuffs the area into city ("Old Palasia, Indore"), so read those fields too.
  for (const field of [location?.city, location?.state]) {
    if (field) pieces.push(...field.toLowerCase().replace(/\./g, "").split(/[,;]+/));
  }
  return pieces.map((p) => normText(p)).filter(Boolean);
}

export type DealerLookup = {
  /** Area matches first (best match first), then the rest of the city/state. */
  dealers: Dealer[];
  /** Cities resolved from the query, as spelled in the dealer list. */
  cities: string[];
  state?: string;
  /** The locality the user named, e.g. "Old Palasia" — set whether or not any dealer matched it. */
  areaLabel?: string;
  /** How many dealers (all at the front of `dealers`) matched `areaLabel`. */
  areaMatchCount: number;
  /** A real city/state the user named that the dealer list doesn't cover (e.g. "Hyderabad"). */
  unservedPlace?: string;
  /** For an unserved place with known coordinates: the closest dealer cities, nearest first. */
  nearbyCities?: NearbyCity[];
};

/** Display name for the first phrase that contains a real place word (not just "road", "nagar", …). */
function labelOf(phrases: string[][]): string | undefined {
  const phrase = phrases.find((p) => p.some((t) => !GENERIC_ADDRESS_WORDS.has(t)));
  if (!phrase || phrase.length > 4) return undefined;
  return phrase.map((t) => (t.length <= 2 ? t.toUpperCase() : t.charAt(0).toUpperCase() + t.slice(1))).join(" ");
}

type ResolvedPlaces = {
  cities: Set<string>;
  state?: string;
  /** Leftover place-ish words that aren't a known city/state — candidate localities. */
  areaPhrases: string[][];
  /** Real places named that the dealer list doesn't cover. */
  unservedHits: { display: string; tokens: string[] }[];
};

/** Reads the cities, states, unserved places and leftover locality words out of a message (+ intent location). */
function resolvePlaces(location: { city?: string; state?: string } | undefined, message: string): ResolvedPlaces {
  const cities = new Set<string>();
  let state: string | undefined;
  const areaPhrases: string[][] = [];
  const unservedHits: { display: string; tokens: string[] }[] = [];

  for (const piece of locationPieces(message, location)) {
    const tokens = piece.split(" ");
    const consumed = new Array<boolean>(tokens.length).fill(false);
    for (let i = 0; i < tokens.length; i++) {
      if (consumed[i]) continue;
      const city = matchNameAt(tokens, i, cityNames, CITY_ALIASES);
      const st = city ? null : matchNameAt(tokens, i, stateNames);
      const hit = city ?? st;
      if (!hit) {
        const unserved = matchNameAt(tokens, i, unservedNames);
        if (unserved) {
          unservedHits.push({ display: unserved.display, tokens: tokens.slice(i, i + unserved.length) });
          for (let k = 0; k < unserved.length; k++) consumed[i + k] = true;
          i += unserved.length - 1;
        }
        continue;
      }
      if (city) cities.add(city.display);
      else if (st) state = st.display;
      for (let k = 0; k < hit.length; k++) consumed[i + k] = true;
      i += hit.length - 1;
    }
    const leftover = tokens.filter((t, i) => !consumed[i] && !NON_PLACE_WORDS.has(t));
    if (leftover.length > 0) areaPhrases.push(leftover);
  }
  return { cities, state, areaPhrases, unservedHits };
}

export function findDealers(
  location: { city?: string; state?: string } | undefined,
  message: string,
  options: { nearest?: boolean } = {}
): DealerLookup {
  const { cities, state, areaPhrases, unservedHits } = resolvePlaces(location, message);

  // The user named a real city/state we have no dealers in ("dealers in Hyderabad near Madhapur").
  // That is a definite "none here" — do NOT go looking for the locality elsewhere in the country.
  if (unservedHits.length > 0 && cities.size === 0 && !state) {
    const unservedPlace = unservedHits[0].display;
    const coord = unservedCoords.get(unservedPlace);
    const nearbyCities = coord ? nearestDealerCities(coord) : [];
    // Only when asked ("show me the nearest ones"): a few dealers from each nearby city, nearest city first,
    // so one big city (Pune has 200+) can't crowd the others out of the card list.
    const nearbyDealers = options.nearest
      ? nearbyCities.flatMap((n) => servedCityPoints.find((p) => p.city === n.city)?.dealers.slice(0, 3) ?? [])
      : [];
    return {
      dealers: nearbyDealers,
      cities: [],
      areaLabel: labelOf(areaPhrases),
      areaMatchCount: 0,
      unservedPlace,
      nearbyCities,
    };
  }
  // A served city was named too ("Nagpur Road, Pune") — keep the unserved words searchable as locality text.
  for (const h of unservedHits) areaPhrases.push(h.tokens);

  // Search units: single words, plus adjacent words joined ("vijay nagar" → "vijaynagar"),
  // so spacing differences between the question and the address don't matter.
  const units: { text: string; joined: boolean; weight: number }[] = [];
  const seen = new Set<string>();
  const addUnit = (text: string, joined: boolean, weight: number) => {
    if (seen.has(text)) return;
    seen.add(text);
    units.push({ text, joined, weight });
  };
  for (const phrase of areaPhrases) {
    for (const t of phrase) {
      if (t.length >= 2 && !GENERIC_ADDRESS_WORDS.has(t) && !/^\d$/.test(t)) addUnit(t, false, 1);
    }
    for (let i = 0; i + 1 < phrase.length; i++) {
      if (phrase.slice(i, i + 2).some((t) => !GENERIC_ADDRESS_WORDS.has(t))) {
        addUnit(phrase[i] + phrase[i + 1], true, 2);
      }
    }
    if (phrase.length > 2 && phrase.some((t) => !GENERIC_ADDRESS_WORDS.has(t))) {
      addUnit(phrase.join(""), true, phrase.length);
    }
  }

  const areaLabel = labelOf(areaPhrases);

  const cityList = Array.from(cities);
  let pool: IndexedDealer[];
  if (cityList.length > 0) {
    const wanted = new Set(cityList.map((c) => normText(c)));
    pool = dealerIndex.filter((e) => wanted.has(normText(e.dealer.city)));
  } else if (state) {
    const wanted = normText(state);
    pool = dealerIndex.filter((e) => normText(e.dealer.state) === wanted);
  } else if (units.length > 0) {
    pool = dealerIndex; // no city named — search every address for the locality
  } else {
    pool = [];
  }

  // Typo tolerance ("Palasiya" → "Palasia") is only safe inside a city/state: nationwide it
  // turns one place into another ("Madhapur" → "Madhapar", a different town in Gujarat).
  const fuzzy = pool !== dealerIndex;
  const scoreOf = (e: IndexedDealer): number => {
    let score = 0;
    for (const u of units) {
      let hit: boolean;
      if (u.joined) {
        hit = u.text.length >= 6 && e.compact.includes(u.text);
      } else {
        hit =
          e.words.includes(u.text) ||
          (u.text.length >= 6 &&
            (e.compact.includes(u.text) ||
              (fuzzy && e.words.some((w) => w.length >= 5 && editDistanceAtMostOne(u.text, w)))));
      }
      if (hit) score += u.weight;
    }
    return score;
  };

  const scored = pool.map((e) => ({ e, score: units.length > 0 ? scoreOf(e) : 0 }));
  const matched = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.e.order - b.e.order);
  const areaMatchCount = matched.length;

  let ranked: IndexedDealer[];
  if (areaMatchCount > 0) {
    const rest = scored.filter((s) => s.score === 0);
    // City/state-scoped: keep the rest of the area after the matches. No scope: matches only.
    ranked = [...matched, ...(pool === dealerIndex ? [] : rest)].map((s) => s.e);
  } else {
    // Named an area nobody lists → fall back to the whole city/state; with no scope, nothing.
    ranked = pool === dealerIndex ? [] : pool;
  }

  return {
    dealers: ranked.map((e) => e.dealer),
    cities: cityList,
    state,
    areaLabel,
    areaMatchCount,
  };
}

type ChatTurn = { role: string; content: string };

/** The most recent place the user named earlier in the chat, for follow-ups like "show me nearby ones". */
export function findPlaceInHistory(history: ChatTurn[]): { city?: string; state?: string } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "user") continue;
    const found = resolvePlaces(undefined, history[i].content);
    if (found.cities.size > 0) return { city: Array.from(found.cities)[0] };
    if (found.state) return { state: found.state };
    if (found.unservedHits.length > 0) return { city: found.unservedHits[0].display };
  }
  return null;
}

const NEAREST_WORDS = /\b(near(?:est|er|by)?|closest|close\s*by)\b/i;
const AFFIRMATIVE = /^\s*(?:yes|yeah|yep|yup|sure|ok(?:ay)?|please|pls|y|go\s+ahead|do\s+it|show(?:\s+me)?|alright|fine)\b/i;
/** Wording of the offer we make when a place has no dealers — see dealerFollowupQuestion. */
const NEAREST_OFFER = /closest\s+Carysil\s+dealers/i;

/**
 * Follow-ups that mean "show me the dealers nearest to the place we were just talking about":
 * "ok show me near ones" / "nearest?" after a dealer answer, or a plain "yes" to our
 * "Would you like me to show the closest Carysil dealers to Hyderabad?". Returns that earlier
 * place, or null if this isn't such a follow-up (a message that names its own place never is).
 */
export function resolveNearestDealerFollowup(
  message: string,
  history: ChatTurn[]
): { city?: string; state?: string } | null {
  // The follow-up question is its own chat bubble, so "were we just on dealers?" looks at the last few turns.
  const recentAssistant = history.slice(-4).filter((h) => h.role === "assistant").map((h) => h.content);
  if (!recentAssistant.some((c) => /\bdealers?\b/i.test(c))) return null;
  const lastAssistant = recentAssistant[recentAssistant.length - 1] ?? "";
  const text = message.trim();
  if (text.length === 0 || text.length > 80) return null;
  const saidYes = NEAREST_OFFER.test(lastAssistant) && AFFIRMATIVE.test(text);
  if (!saidYes && !NEAREST_WORDS.test(text)) return null;
  const own = resolvePlaces(undefined, text);
  if (own.cities.size > 0 || own.state || own.unservedHits.length > 0 || own.areaPhrases.length > 0) return null;
  return findPlaceInHistory(history);
}

/**
 * Picks the single dealer to route a lead to from an already location-filtered
 * list. Prefers a dealer whose products_supported covers the user's product
 * category, but never re-ranks by location — findDealers already ranked the
 * list (best locality match first). Deterministic (first match) rather than
 * randomized so the same lead context always routes the same way.
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
  /** A place with no dealers but known distances — offer to show the closest ones (see resolveNearestDealerFollowup). */
  offerNearestTo?: string;
}): string {
  if (input.dealerCount === 0 && input.offerNearestTo) {
    return `Would you like me to show the closest Carysil dealers to ${input.offerNearestTo}?`;
  }
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
  const words = normText(match[1]).split(" ").filter(Boolean);
  // "show me near ones" / "dealer near me" name no place — don't invent a city called "Ones".
  if (words.length === 0 || words.every((w) => NON_PLACE_WORDS.has(w))) return null;
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
