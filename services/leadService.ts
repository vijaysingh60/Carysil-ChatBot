import { sanitizeInferredCityValue } from "@/lib/inferredCitySanitize";
import { getDbPool } from "@/lib/db";
import type { ContactInfo, DetectedSalesIntent, LeadUpdate } from "@/types/lead";
import { ensureLeadSchema } from "@/services/sessionService";

type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

const EMAIL_PATTERN = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i;
const PHONE_PATTERN = /(?:\+91[\s-]?)?[6-9]\d{9}\b/;

function firstPhoneMatch(message: string): RegExpMatchArray | null {
  return message.match(PHONE_PATTERN);
}

function cleanPhone(phone: string): string {
  return phone.replace(/[^\d+]/g, "");
}

function titleCase(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/** One-line reply that is probably a city/region, not a product sentence (used before history fallback). */
function looksLikeBarePlaceNameLine(message: string): boolean {
  const t = message.trim();
  if (t.length < 2 || t.length > 60) return false;
  if (/[?]/.test(t)) return false;
  if (/\b(sink|faucet|faucets|tap|taps|product|products|dealer|dealers|show|sure|need|want|please|quote|price|email|phone|call)\b/i.test(t)) {
    return false;
  }
  return /^[a-zA-Z][a-zA-Z\s.-]*$/.test(t);
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

/** Last 10 digits for Indian mobile comparison */
function normalizePhone10(phoneOrMessage: string): string {
  const d = digitsOnly(phoneOrMessage);
  if (d.length <= 10) return d;
  if (d.startsWith("91") && d.length >= 12) return d.slice(-10);
  return d.slice(-10);
}

const NAME_JUNK =
  /\b(my\s+number|here\s+is|call\s+me|phone\s+is|mobile\s+is|whatsapp|reach\s+me|contact|number\s+is)\b/i;

const NOT_NAME_LINE =
  /\b(sink|faucet|taps?|hob|hobs|chimney|disposer|dealer|show|need|want|product|products|budget|quote|price|hello|hi|thanks|please)\b/i;

/** Tokens that often appear in product chips (e.g. "Deck Mount") but are not person names. */
const PRODUCT_NAME_TOKENS = new Set([
  "deck",
  "wall",
  "mount",
  "single",
  "double",
  "bowl",
  "chrome",
  "matte",
  "matt",
  "black",
  "pull",
  "out",
  "spray",
  "quartz",
  "stainless",
  "steel",
  "pvd",
  "induction",
  "gas",
  "kitchen",
  "bathroom",
  "combo",
  "sink",
  "faucet",
  "tap",
  "taps",
  "hob",
  "hobs",
  "chimney",
  "disposer",
  "accessory",
  "accessories",
  "built",
  "free",
  "standing",
  "undermount",
  "topmount",
]);

const PRODUCT_NAME_PHRASE = /\b(deck|wall)[\s-]*mount|single[\s-]*bowl|double[\s-]*bowl|pull[\s-]?out|matte\s+black|matt\s+black|rose\s+gold|gun\s+metal|stainless\s+steel|built[\s-]?in|free[\s-]?standing\b/i;

function couldBePersonNameChunk(chunk: string): boolean {
  const t = chunk.trim();
  if (t.length < 2 || t.length > 60) return false;
  if (NAME_JUNK.test(t) || NOT_NAME_LINE.test(t)) return false;
  if (PRODUCT_NAME_PHRASE.test(t)) return false;
  if (!/^[A-Za-z][A-Za-z\s.'-]*$/.test(t)) return false;
  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length > 6) return false;
  if (parts.some((p) => PRODUCT_NAME_TOKENS.has(p.toLowerCase()))) return false;
  return parts.every((p) => /^[A-Za-z][a-zA-Z.'-]*$/.test(p));
}

function parseNameFromLabeledLine(message: string): string | null {
  const m = message.match(
    /\b(?:name|full\s*name)\s*[:=\-–—]\s*([A-Za-z][A-Za-z\s.'-]{1,48})(?=\s*(?:,|;|\n|\d|\s*$))/i
  );
  if (!m?.[1]) return null;
  const raw = m[1].trim();
  if (!couldBePersonNameChunk(raw)) return null;
  return titleCase(raw);
}

function parseNameAdjacentToPhone(message: string): string | null {
  const m = firstPhoneMatch(message);
  if (!m || m.index === undefined) return null;
  const rawPhone = m[0];
  const idx = m.index;
  const before = message.slice(0, idx).trim().replace(/[,;:]+$/g, "").trim();
  const after = message.slice(idx + rawPhone.length).trim().replace(/^[,;:)\s]+/g, "").trim();

  const fromChunk = (chunk: string): string | null => {
    if (!couldBePersonNameChunk(chunk)) return null;
    const parts = chunk.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return titleCase(chunk);
    if (parts.length === 1 && parts[0].length >= 3) return titleCase(chunk);
    return null;
  };

  return fromChunk(before) || fromChunk(after);
}

/** Previous line was only a name; this line is only phone — common two-step entry on mobile. */
function nameFromPriorUserTurn(message: string, phone: string | undefined, history: ConversationMessage[]): string | null {
  if (!phone) return null;
  const msgNorm = normalizePhone10(message);
  const phoneNorm = normalizePhone10(phone);
  if (msgNorm !== phoneNorm) return null;
  const letters = message.replace(/[\d\s+().\-,]/g, "");
  if (letters.length > 2) return null;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry.role !== "user") continue;
    const prev = entry.content.trim();
    if (!prev || /[6-9]\d{9}/.test(prev)) continue;
    if (!couldBePersonNameChunk(prev)) continue;
    const parts = prev.split(/\s+/).filter(Boolean);
    if (parts.length >= 1 && parts.length <= 5 && (parts.length >= 2 || (parts.length === 1 && parts[0].length >= 3))) {
      return titleCase(prev);
    }
  }
  return null;
}

export function extractContactInfo(
  message: string,
  salesIntent?: DetectedSalesIntent,
  history: ConversationMessage[] = []
): ContactInfo {
  const info: ContactInfo = {};
  const email = message.match(EMAIL_PATTERN)?.[0];
  const phone = message.match(PHONE_PATTERN)?.[0];
  if (email) info.email = email;
  if (phone) info.phone = cleanPhone(phone);

  const labeled = parseNameFromLabeledLine(message);
  if (labeled) info.name = labeled;

  const nameMatch = message.match(
    /\b(?:my\s+name\s+is|name\s+is|i\s+am|i'm)\s+([A-Za-z][a-zA-Z]+(?:\s+[A-Za-z][a-zA-Z]+){0,4})\b/
  );
  if (!info.name && nameMatch) {
    info.name = titleCase(nameMatch[1]);
  } else if (!info.name && (email || phone) && message.includes(",")) {
    const firstPart = message.split(",")[0]?.trim();
    if (firstPart && /^[a-zA-Z\s.'-]{2,40}$/.test(firstPart) && couldBePersonNameChunk(firstPart)) {
      info.name = titleCase(firstPart);
    }
  }

  if (!info.name && phone) {
    const adjacent = parseNameAdjacentToPhone(message);
    if (adjacent) info.name = adjacent;
  }

  if (!info.name && phone) {
    const fromHistory = nameFromPriorUserTurn(message, info.phone, history);
    if (fromHistory) info.name = fromHistory;
  }

  /** Two-word name-only line (no phone) — avoid classifying as city below */
  if (!info.name && !phone && !email) {
    const t = message.trim();
    if (couldBePersonNameChunk(t)) {
      const w = t.split(/\s+/).filter(Boolean);
      if (w.length >= 2 && w.length <= 4) info.name = titleCase(t);
    }
  }

  const explicitCity = message.match(/\b(?:city(?:\s+is)?|in|from|at)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})\b/)?.[1];
  if (explicitCity) {
    const s = sanitizeInferredCityValue(explicitCity);
    if (s) info.city = s;
  } else if (salesIntent?.city) {
    const s = sanitizeInferredCityValue(salesIntent.city);
    if (s) info.city = s;
  } else if ((email || phone) && message.includes(",")) {
    const parts = message.split(",").map((part) => part.trim()).filter(Boolean);
    const cityCandidate = parts.find((part, index) => index > 0 && /^[a-zA-Z\s]{2,40}$/.test(part));
    if (cityCandidate) {
      const s = sanitizeInferredCityValue(cityCandidate);
      if (s) info.city = s;
    }
  } else if (!info.name && looksLikeBarePlaceNameLine(message)) {
    const s = sanitizeInferredCityValue(message.trim());
    if (s) info.city = s;
  }

  // Only infer city from prior **user** turns — assistant text ("reach out in Indore") caused false lead capture.
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (info.city) break;
    if (history[index].role !== "user") continue;
    const previousCity = history[index].content.match(/\b(?:in|from|city(?:\s+is)?)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})\b/)?.[1];
    if (previousCity) {
      const s = sanitizeInferredCityValue(previousCity);
      if (s) info.city = s;
    }
  }

  return info;
}

export async function getLeadPhoneEmail(
  sessionId: string
): Promise<{ phone: string | null; email: string | null }> {
  const snap = await getLeadContactSnapshot(sessionId);
  return { phone: snap.phone ?? null, email: snap.email ?? null };
}

/** Current PII on the lead row — used to merge split name-then-phone replies and to gate writes. */
export async function getLeadContactSnapshot(sessionId: string): Promise<ContactInfo> {
  if (!(await ensureLeadSchema())) {
    return {};
  }
  try {
    const pool = getDbPool();
    const res = await pool.query<{
      name: string | null;
      phone: string | null;
      email: string | null;
      city: string | null;
    }>(`SELECT name, phone, email, city FROM leads WHERE session_id = $1 LIMIT 1`, [sessionId]);
    const row = res.rows[0];
    if (!row) return {};
    const out: ContactInfo = {};
    if (row.name) out.name = row.name;
    if (row.phone) out.phone = row.phone;
    if (row.email) out.email = row.email;
    if (row.city) out.city = row.city;
    return out;
  } catch (e) {
    console.error("[lead] getLeadContactSnapshot failed", e);
    return {};
  }
}

/**
 * Merge extracted contact with DB for a write. When allowNewPii is false, do not pass new
 * name/phone/email (avoids saving chip text like "Deck Mount" as a name during product browse).
 */
export function contactInfoForLeadDatabaseUpdate(
  extracted: ContactInfo,
  stored: ContactInfo,
  allowNewPii: boolean
): ContactInfo {
  if (!allowNewPii) {
    const out: ContactInfo = {};
    if (extracted.city !== undefined && extracted.city !== null && String(extracted.city).trim() !== "") {
      out.city = extracted.city;
    }
    return out;
  }
  return {
    name: extracted.name ?? stored.name,
    phone: extracted.phone ?? stored.phone,
    email: extracted.email ?? stored.email,
    city: extracted.city ?? stored.city,
  };
}

/** In-memory contact for scoring / follow-up engine — ignores freshly parsed PII when not in capture window. */
export function mergeContactForRuntime(
  extracted: ContactInfo,
  stored: ContactInfo,
  allowNewPii: boolean
): ContactInfo {
  return {
    phone: allowNewPii ? (extracted.phone ?? stored.phone) : stored.phone,
    email: allowNewPii ? (extracted.email ?? stored.email) : stored.email,
    name: allowNewPii ? (extracted.name ?? stored.name) : stored.name,
    city: extracted.city ?? stored.city,
  };
}

export function calculateLeadScore(input: {
  salesIntent: DetectedSalesIntent;
  contactInfo?: ContactInfo;
  recommendationsShown?: number;
  dealersShown?: number;
}): number {
  let score = input.recommendationsShown ? 1 : 0;
  if (input.salesIntent.signals.includes("budget_purchase")) score += 3;
  if (input.salesIntent.signals.includes("dealer_inquiry") || input.dealersShown) score += 5;
  if (input.salesIntent.signals.includes("quotation_request") || input.salesIntent.signals.includes("contact_request")) score += 7;
  if (input.contactInfo?.phone) score += 10;
  if (input.contactInfo?.email) score += 10;
  if (input.contactInfo?.city) score += 2;
  return score;
}

export async function updateLead(sessionId: string, update: LeadUpdate): Promise<void> {
  const hasInterestedProducts = Array.isArray(update.interestedProducts) && update.interestedProducts.length > 0;
  const hasMeaningfulUpdate =
    update.scoreDelta > 0 ||
    update.name ||
    update.phone ||
    update.email ||
    update.city ||
    update.intent ||
    update.interestedProduct ||
    update.followupStage ||
    hasInterestedProducts;
  if (!hasMeaningfulUpdate) return;
  if (!(await ensureLeadSchema())) return;

  try {
    const pool = getDbPool();
    await pool.query(
      `
      INSERT INTO leads (
        session_id, name, phone, email, city, intent, interested_product,
        interested_products, followup_stage, lead_score, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8::jsonb, COALESCE($9, 'browsing'), $10, NOW()
      )
      ON CONFLICT (session_id) DO UPDATE SET
        name = COALESCE(EXCLUDED.name, leads.name),
        phone = COALESCE(EXCLUDED.phone, leads.phone),
        email = COALESCE(EXCLUDED.email, leads.email),
        city = COALESCE(EXCLUDED.city, leads.city),
        intent = COALESCE(EXCLUDED.intent, leads.intent),
        interested_product = COALESCE(EXCLUDED.interested_product, leads.interested_product),
        interested_products = CASE
          WHEN $11::boolean THEN (
            SELECT COALESCE(jsonb_agg(DISTINCT elem), '[]'::jsonb)
            FROM (
              SELECT jsonb_array_elements(COALESCE(leads.interested_products, '[]'::jsonb)) AS elem
              UNION
              SELECT jsonb_array_elements(EXCLUDED.interested_products) AS elem
            ) merged
          )
          ELSE leads.interested_products
        END,
        followup_stage = COALESCE(EXCLUDED.followup_stage, leads.followup_stage),
        lead_score = LEAST(100, leads.lead_score + EXCLUDED.lead_score),
        updated_at = NOW()
      `,
      [
        sessionId,
        update.name ?? null,
        update.phone ?? null,
        update.email ?? null,
        update.city ?? null,
        update.intent ?? null,
        update.interestedProduct ?? null,
        JSON.stringify(update.interestedProducts ?? []),
        update.followupStage ?? null,
        update.scoreDelta,
        hasInterestedProducts,
      ]
    );
  } catch (error) {
    console.error("[tracking] updateLead failed", error);
  }
}
