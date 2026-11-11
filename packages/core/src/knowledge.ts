import type { Promotion, Settings, Snapshot } from "./types.ts";

const BANGKOK = "Asia/Bangkok";

function bangkokParts(now: Date): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BANGKOK,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

export function bangkokDate(now: Date): string {
  return bangkokParts(now).date;
}

export function isPromotionActive(promotion: Promotion, now: Date): boolean {
  const today = bangkokDate(now);
  if (promotion.starts_at && today < promotion.starts_at) return false;
  if (promotion.ends_at && today > promotion.ends_at) return false;
  return true;
}

function toMinutes(value: string): number {
  const [hours = 0, minutes = 0] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

export function isWithinBotHours(settings: Settings, now: Date): boolean {
  const current = bangkokParts(now).minutes;
  const start = toMinutes(settings.bot_hours.start);
  const end = toMinutes(settings.bot_hours.end);
  if (start === end) return true;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export interface GateInput {
  settings: Settings;
  now: Date;
  humanTakeoverUntil?: Date | null;
}

export function gateReason({ settings, now, humanTakeoverUntil }: GateInput): string | null {
  if (!settings.enabled) return "bot_disabled";
  if (humanTakeoverUntil && humanTakeoverUntil > now) return "human_takeover";
  if (!isWithinBotHours(settings, now)) return "outside_bot_hours";
  return null;
}

/** Every source the model may cite, keyed by id. The text is what numbers are checked against. */
export function buildSources(snapshot: Snapshot, now: Date): Map<string, string> {
  const sources = new Map<string, string>();
  for (const product of snapshot.products) {
    sources.set(`product:${product.sku}`, JSON.stringify(product));
  }
  for (const promotion of snapshot.promotions) {
    if (isPromotionActive(promotion, now)) sources.set(`promo:${promotion.id}`, JSON.stringify(promotion));
  }
  for (const spec of snapshot.specs) sources.set(`spec:${spec.id}`, JSON.stringify(spec));
  // Search keywords are left out, so the model and the number checks see only the answer itself.
  for (const { keywords: _searchOnly, ...faq } of snapshot.faqs) sources.set(`faq:${faq.id}`, JSON.stringify(faq));
  return sources;
}

export function renderKnowledge(sources: Map<string, string>): string {
  return [...sources].map(([id, text]) => `[${id}] ${text}`).join("\n");
}
