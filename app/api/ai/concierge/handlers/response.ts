export function sanitizeFollowupQuestion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  if (trimmed.length > 240) return null;
  if (/\b(phone|email|whatsapp|mobile|contact\s+number|your\s+number)\b/i.test(trimmed)) return null;
  if (!/[?？]\s*$/.test(trimmed)) {
    const withoutStop = trimmed.replace(/[.!…]+$/g, "").trim();
    if (!withoutStop) return null;
    if (/^(would|do|are|is|can|could|should|shall|may|have\s+you|need\s+you)\b/i.test(withoutStop)) {
      trimmed = `${withoutStop}?`;
    } else {
      return null;
    }
  }
  return trimmed;
}

export function stripCatalogueEchoFromIntro(intro: string, hasProductCards: boolean): string {
  if (!hasProductCards || !intro.trim()) return intro;
  const lines = intro.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\d+[\.)]\s+/.test(trimmed)) break;
    const inlineSplit = trimmed.match(/^(.{8,}?)\s+\d+[\.)]\s+.+/);
    if (inlineSplit) {
      kept.push(inlineSplit[1].trimEnd());
      break;
    }
    kept.push(line);
  }
  let t = kept.join("\n").replace(/\*\*([^*]+)\*\*/g, "$1").trim();
  t = t.replace(/\n*\s*(I hope one of these (catches your eye|works for you)|Let me know if any of these (appeal|work))[!.\s]*$/i, "").trim();
  t = t.replace(/[:—\-]\s*$/g, "").trim();
  if (t.length < 16) {
    return "Here are some curated picks from our catalogue that should suit what you're looking for.";
  }
  return t;
}

export function stripTrailingFollowup(intro: string, followup: string): string {
  const t = followup.trim();
  if (!t || !intro) return intro;
  const lowerIntro = intro.toLowerCase();
  const lowerQ = t.toLowerCase();
  const glued = `\n\n${t}`;
  if (lowerIntro.endsWith(lowerQ)) {
    const idx = lowerIntro.lastIndexOf(lowerQ);
    return intro.slice(0, idx).replace(/\n+\s*$/, "").trim();
  }
  if (lowerIntro.endsWith(glued.toLowerCase())) {
    return intro.slice(0, -glued.length).trim();
  }
  return intro;
}
