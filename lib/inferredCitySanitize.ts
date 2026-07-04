/**
 * Heuristic cleanup for regex-inferred "city" values before analytics / lead storage.
 * Prevents product lines, brand names, and chip text from polluting the city column.
 */

const NOT_A_PLACE_TOKEN = new Set(
  [
    "carysil",
    "sink",
    "sinks",
    "faucet",
    "faucets",
    "tap",
    "taps",
    "hob",
    "hobs",
    "chimney",
    "chimneys",
    "dishwasher",
    "dishwashers",
    "disposer",
    "disposers",
    "combo",
    "combos",
    "accessory",
    "accessories",
    "appliance",
    "appliances",
    "spout",
    "kitchen",
    "bathroom",
    "bath",
    "budget",
    "premium",
    "luxury",
    "range",
    "product",
    "products",
    "show",
    "explore",
    "recommend",
    "me",
    "you",
    "want",
    "need",
    "please",
    "full",
    "deck",
    "wall",
    "mount",
    "pull",
    "out",
    "single",
    "double",
    "bowl",
    "quartz",
    "steel",
    "chrome",
    "black",
    "gas",
    "induction",
    "burner",
    "burners",
    "basin",
    "shower",
    "waste",
    "food",
    "garbage",
    "disposal",
    "installation",
    "install",
    "dealer",
    "dealers",
    "store",
    "showroom",
    "hello",
    "thanks",
    "thank",
    "yes",
    "yeah",
    "okay",
    "sure",
  ].map((s) => s.toLowerCase())
);

function tokenKey(token: string): string {
  return token.replace(/[^a-zA-Z]/g, "").toLowerCase();
}

/**
 * Returns null if the value is clearly not a geographic city/region label.
 */
export function sanitizeInferredCityValue(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const t = raw.trim().replace(/\s+/g, " ");
  if (!t) return null;
  if (t.length > 42) return null;

  const words = t.split(" ").filter(Boolean);
  if (words.length === 0) return null;
  if (words.length > 4) return null;

  if (/[0-9@#$%^&*()[\]{}]/.test(t)) return null;

  const lowerFull = t.toLowerCase();
  if (/\b(i|we)\s+(want|need|am|are)\b/.test(lowerFull)) return null;
  if (/\b(show|give)\s+me\b/.test(lowerFull)) return null;

  // Split on hyphens too when checking the blocklist — otherwise a compound
  // like "deck-mount" collapses to the fused, unblocked token "deckmount".
  for (const w of t.split(/[\s-]+/)) {
    const key = tokenKey(w);
    if (key.length < 2) continue;
    if (NOT_A_PLACE_TOKEN.has(key)) return null;
  }

  return t
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}
