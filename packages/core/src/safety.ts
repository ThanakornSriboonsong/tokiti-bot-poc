import type { ModelAnswer, Settings, StockItem } from "./types.ts";

const THAI_DIGITS = "๐๑๒๓๔๕๖๗๘๙";

function normalizeDigits(text: string): string {
  return text.replace(/[๐-๙]/g, (digit) => String(THAI_DIGITS.indexOf(digit)));
}

const URL_PATTERN = /https?:\/\/\S+/g;

export function extractNumbers(text: string): string[] {
  const clean = normalizeDigits(text).replace(URL_PATTERN, " ");
  return [...clean.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((match) => match[0].replace(/,/g, ""));
}

/** Prices named in the reply, in either `590 บาท` or `฿590` form. */
export function extractPrices(text: string): string[] {
  const clean = normalizeDigits(text).replace(URL_PATTERN, " ");
  const after = [...clean.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(?:บาท|฿|thb)/gi)].map((match) => match[1]!);
  const before = [...clean.matchAll(/(?:฿|thb)\s*(\d[\d,]*(?:\.\d+)?)/gi)].map((match) => match[1]!);
  return [...after, ...before].map((value) => value.replace(/,/g, ""));
}

const RISKY_CUSTOMER_TEXT =
  /คืนเงิน|ขอเงินคืน|ยกเลิก|เคลม|ร้องเรียน|แจ้งความ|โกง|ของเสีย|ของแตก|แตกหัก|ชำรุด|พัง|ส่งผิด|ได้ของไม่ครบ|ไม่ได้รับของ|refund|cancel|claim|broken|damaged/i;

const CUSTOMER_RULES: { pattern: RegExp; reason: string }[] = [
  { pattern: RISKY_CUSTOMER_TEXT, reason: "risky_customer_text" },
  { pattern: /(โอน|จ่าย|ชำระ)(เงิน)?(ไป|มา|ให้)?(แล้ว|เรียบร้อย)/, reason: "payment_claim" },
  {
    pattern:
      /ignore\s+(all\s+|any\s+|your\s+|the\s+)*(previous|prior|above|instructions?|rules?)|disregard\s+(all\s+|any\s+|your\s+|the\s+)*(previous|prior|above|instructions?|rules?)|system\s*prompt|your\s+(prompt|instructions)|^\s*system\s*:|<\/?customer>|get_my_orders|get_stock|ลืมกฎ|ลืมคำสั่ง|ไม่ต้องสนกฎ|ข้ามกฎ|เปลี่ยนกฎ|(ข้อความ|คำสั่ง|พรอมต์|พร้อมต์)(ของ)?ระบบ|คำสั่งที่ตั้งไว้|ไม่มีข้อจำกัด|ทำตัวเป็น|แกล้งเป็น|สมมติว่าคุณเป็น/i,
    reason: "prompt_injection",
  },
  {
    pattern: /(ลูกค้า|คน)(ท่าน|คน)?อื่น|ลูกค้าทุกคน|ของลูกค้า|ลูกค้าท่านนี้|ออเดอร์ของ(เพื่อน|แฟน|พี่|น้อง|แม่|พ่อ|คุณ\S)|คนที่สั่ง/,
    reason: "other_customer_data",
  },
  {
    pattern: /\b(?:WEB|PO|POS)-[A-Z0-9-]*\d[A-Z0-9-]*|(?:ออเดอร์|order)\s*(?:เลขที่|เลข|#)?\s*\d{3,}/i,
    reason: "typed_order_code",
  },
  {
    pattern: /ส่ง(ให้)?ทัน|ทันวัน|ให้ทันก่อน|ต้องได้ของ|ต้องถึง|ยืนยัน\S*(วันถึง|ว่าถึง|ว่าได้ของ)|รับประกัน\S*(ถึง|ส่ง)|การันตี\S*(ถึง|ส่ง)|ถึงพรุ่งนี้|ได้พรุ่งนี้/,
    reason: "delivery_deadline",
  },
];

/** Always sent to staff, before any model call, so these messages never depend on the model. */
export function customerRiskReasons(customerText: string): string[] {
  return CUSTOMER_RULES.filter(({ pattern }) => pattern.test(customerText)).map(({ reason }) => reason);
}

const FORBIDDEN_REPLY: { pattern: RegExp; reason: string }[] = [
  { pattern: /คืนเงินให้|จะคืนเงิน|อนุมัติการคืน/, reason: "promise_refund" },
  { pattern: /ได้รับเงินแล้ว|รับเงินแล้ว|ยืนยันการชำระ|ชำระเงินเรียบร้อย|สลิปถูกต้อง|ตรวจสลิปแล้ว/, reason: "promise_payment" },
  { pattern: /ถึงพรุ่งนี้|ถึงภายใน|ได้รับภายใน|ส่งถึงภายใน|ถึงแน่นอน|ส่งทันวัน/, reason: "promise_delivery" },
  { pattern: /รับประกัน|การันตี|รักษา|ป้องกันเชื้อรา|ฆ่าเชื้อ/, reason: "promise_claim" },
  { pattern: /บ้านแมว/, reason: "wrong_product_name" },
  { pattern: /iShip|order_status|parcel|\bsync\b/i, reason: "internal_term" },
  // Bank details are rendered by ordering.ts from the shop's settings, never written by the model.
  { pattern: /เลขบัญชี|เลขที่บัญชี|พร้อมเพย์|promptpay|\d{3}-\d-\d{5}-\d/i, reason: "bank_details_from_model" },
];

// The lookahead keeps product talk like "มีของใช้สำหรับน้องแมว" from counting as a stock claim.
const STOCK_WORDS = "พร้อมส่ง|มีของ(?!ใช้|เล่น|แถม)|มีสินค้า(?!ให้เลือก)|ยังมีของ|ยังมีสินค้า|ของเข้า|สินค้าหมด|ของหมด|หมดแล้ว";
const STOCK_CLAIM = new RegExp(STOCK_WORDS);
// "พร้อมส่งไหม" asks about stock rather than stating it. Only "อยู่" or "แล้ว" may sit in
// between, so a statement like "มีของค่ะ สนใจไหม" is still treated as a claim.
const STOCK_QUESTION = new RegExp(`(?:${STOCK_WORDS})(?:อยู่|แล้ว)?\\s*(?:ไหม|มั้ย|หรือเปล่า|รึเปล่า|หรือยัง)`, "g");

/** True when the reply states stock, ignoring places where it only asks about stock. */
export function claimsStock(reply: string): boolean {
  return STOCK_CLAIM.test(reply.replace(STOCK_QUESTION, " "));
}

export interface SafetyInput {
  answer: ModelAnswer;
  customerText: string;
  sources: Map<string, string>;
  stockChecks: StockItem[];
  settings: Settings;
}

/** Returns the reasons to refuse this reply. Any reason turns the reply into a handoff. */
export function checkAnswer({ answer, customerText, sources, stockChecks, settings }: SafetyInput): string[] {
  const reasons: string[] = [];
  const reply = answer.reply_th;

  reasons.push(...customerRiskReasons(customerText));
  if (answer.topic === "risky") reasons.push("risky_topic");
  if (answer.action === "handoff") return reasons;

  if (answer.topic !== "other" && !settings.topics.includes(answer.topic)) reasons.push("topic_disabled");
  // A question back states no facts, so the bot may ask even when unsure. The number checks still apply.
  if (answer.action === "answer" && answer.confidence < settings.min_confidence) reasons.push("low_confidence");

  const unknownIds = answer.source_ids.filter((id) => !sources.has(id));
  if (unknownIds.length > 0) reasons.push("unknown_source");
  if (answer.action === "answer" && answer.source_ids.length === 0) reasons.push("no_source");

  const cited = answer.source_ids.flatMap((id) => {
    const text = sources.get(id);
    return text === undefined ? [] : [text];
  });
  const citedNumbers = new Set(cited.flatMap(extractNumbers));
  const customerNumbers = new Set(extractNumbers(customerText));

  // A customer can repeat a wrong price, so prices must come from a cited source.
  for (const price of extractPrices(reply)) {
    if (!citedNumbers.has(price)) reasons.push("price_not_in_source");
  }
  for (const value of extractNumbers(reply)) {
    if (!citedNumbers.has(value) && !customerNumbers.has(value)) reasons.push("number_not_in_source");
  }

  for (const { pattern, reason } of FORBIDDEN_REPLY) {
    if (pattern.test(reply)) reasons.push(reason);
  }

  const citesStock = answer.source_ids.some((id) => id.startsWith("stock:"));
  if ((answer.topic === "stock_restock" || claimsStock(reply)) && !citesStock) {
    reasons.push("stock_without_live_read");
  }
  if (stockChecks.some((item) => item.status === "unknown")) reasons.push("stock_unknown");

  return [...new Set(reasons)];
}
