import type { ContactInfo } from "@/types/lead";
import type { ConversationMessage } from "@/lib/followupEngine";
import { extractLeadData, recentlyAskedForLeadDetails } from "@/lib/followupEngine";
import { isLikelyLocationReply } from "./intent";

export function userProvidedLeadSignals(message: string, contactFromMessageOnly: ContactInfo): boolean {
  const trimmed = message.trim();
  if (/\b[6-9]\d{9}\b/.test(trimmed) || /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(trimmed)) return true;
  if (contactFromMessageOnly.phone || contactFromMessageOnly.email) return true;
  if (contactFromMessageOnly.city && trimmed.length <= 80) {
    const city = contactFromMessageOnly.city.toLowerCase();
    if (new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(trimmed)) return true;
  }
  if (isLikelyLocationReply(trimmed)) {
    const lower = trimmed.toLowerCase();
    if (
      /\b(sure|yes|yeah|ok|please|show|want|need|give|tell|me|some|any|product|products|sink|faucets?|taps?|dealer|quote|price)\b/.test(lower)
    ) {
      return false;
    }
    return true;
  }
  return false;
}

export function recentlyOfferedDealerConnect(history: ConversationMessage[]): boolean {
  return history
    .slice(-4)
    .some(
      (msg) =>
        msg.role === "assistant" &&
        /\b(connect you|dealer near|carysil dealer|team can assist|would you like me to connect)\b/i.test(msg.content)
    );
}

export function isAffirmativeLeadReply(message: string): boolean {
  return /^(yes|yeah|yep|sure|ok|okay|please|connect me|call me|sounds good|do it)[\s.!]*$/i.test(message.trim());
}

export function hasContactInfo(info: ContactInfo): boolean {
  return Boolean(info.name || info.phone || info.email || info.city);
}

export function hasValidIndianMobileInText(text: string): boolean {
  return /(?:\+91[\s-]?)?[6-9]\d{9}\b/.test(text);
}

export function looksLikeDeferredContactCaptureReply(
  message: string,
  history: ConversationMessage[],
  hasDeferred: boolean
): boolean {
  if (!hasDeferred || !recentlyAskedForLeadDetails(history)) return false;
  const p = extractLeadData(message, undefined, history);
  if (p.name || p.email || p.phone) return true;
  const digits = message.replace(/\D/g, "");
  if (digits.length >= 7) return true;
  const t = message.trim();
  if (t.length < 2 || t.length > 45) return false;
  if (!/^[A-Za-z][a-zA-Z\s.'-]*$/.test(t)) return false;
  if (t.split(/\s+/).filter(Boolean).length > 4) return false;
  if (
    /\b(sink|sinks|faucet|faucets|taps?|hob|hobs|chimney|disposer|kitchen|bathroom|show|want|need|budget|price|dealer|combo|appliance)\b/i.test(t)
  ) {
    return false;
  }
  return true;
}
