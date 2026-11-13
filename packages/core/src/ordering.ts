// Ordering through chat. The model may only ask for a quote, a summary or a confirmation;
// every price, total and bank detail the customer sees is rendered here from tool data.

export interface OrderLine {
  sku: string;
  qty: number;
}

export interface Recipient {
  name: string;
  phone: string;
  address: string;
  postcode: string;
}

export interface QuoteLine {
  sku: string;
  name: string;
  qty: number;
  unit_price: number;
  line_total: number;
}

export interface OrderQuote {
  /** Anything but "ready" means the order can't be placed as asked, for example out of stock. */
  status: string;
  lines: QuoteLine[];
  subtotal: number;
  shipping_fee: number;
  total: number;
  signature: string;
}

export type DraftState = "collecting" | "summary_sent" | "awaiting_slip" | "slip_received" | "reviewed" | "cancelled";

export interface OrderDraft {
  id: string;
  state: DraftState;
  lines: OrderLine[];
  recipient: Recipient | null;
  quote: OrderQuote | null;
  /** The exact summary text the customer was sent. */
  summary_text: string | null;
  /** Set by the app: true only when the summary is the shop's latest message in this chat. */
  summary_is_latest: boolean;
}

export interface BankDetails {
  bank_name: string;
  account: string;
  holder: string;
}

/** The app reads and stores drafts; the pipeline never writes anything itself. */
export interface OrderingProvider {
  quote(lines: OrderLine[], postcode: string | null): Promise<OrderQuote>;
  /** The customer's open draft (not reviewed or cancelled), if any. */
  current(customerId: string): Promise<OrderDraft | null>;
  bank(): Promise<BankDetails | null>;
}

/**
 * What the app must store before it sends the reply. If storing fails, the reply must not be sent.
 * `summary` opens or replaces the draft; `confirm` moves it to awaiting_slip; `slip` records the image.
 */
export type OrderEffect =
  | { kind: "summary"; draft_id: string | null; lines: OrderLine[]; recipient: Recipient; quote: OrderQuote; summary_text: string }
  | { kind: "confirm"; draft_id: string; quote: OrderQuote }
  | { kind: "slip"; draft_id: string };

export const MAX_ORDER_LINES = 20;
export const MAX_LINE_QTY = 99;

export const SLIP_RECEIVED_REPLY = "ได้รับสลิปแล้วค่ะ ทีมงานกำลังตรวจสอบยอด แล้วจะแจ้งกลับนะคะ 🐾";

const baht = (value: number) => `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} บาท`;

export function renderSummary(quote: OrderQuote, recipient: Recipient): string {
  const lines = quote.lines.map((line) => `- ${line.name} x${line.qty} = ${baht(line.line_total)}`);
  return [
    "สรุปออเดอร์ค่ะ",
    ...lines,
    `ค่าส่ง ${baht(quote.shipping_fee)}`,
    `ยอดรวม ${baht(quote.total)}`,
    "",
    `ส่งถึง ${recipient.name} โทร ${recipient.phone}`,
    `${recipient.address} ${recipient.postcode}`,
    "",
    "ถ้าถูกต้อง พิมพ์ \"ยืนยัน\" ได้เลยค่ะ ถ้าจะแก้ไข บอกได้เลยนะคะ",
  ].join("\n");
}

export function renderPayment(quote: OrderQuote, bank: BankDetails): string {
  return [
    "ยืนยันออเดอร์แล้วค่ะ",
    `ยอดชำระ ${baht(quote.total)}`,
    "",
    "โอนเข้าบัญชี",
    bank.bank_name,
    `เลขบัญชี ${bank.account}`,
    `ชื่อบัญชี ${bank.holder}`,
    "",
    "โอนแล้วส่งสลิปในแชทนี้ได้เลยนะคะ ทีมงานจะตรวจยอดแล้วแจ้งกลับค่ะ",
  ].join("\n");
}

const NEGATIVE = /ไม่|ยัง|เดี๋ยว|รอก่อน|ขอคิด|แก้|เปลี่ยน|ยกเลิก|\bno\b|\bnot\b|wait|cancel/i;
const AFFIRMATIVE = /ยืนยัน|ตกลง|โอเค|โอเช|ok(ay)?\b|ได้(เลย)?(ค่ะ|คะ|ครับ|จ้า|ค่า)?$|เอา(เลย|ค่ะ|ครับ)|สั่งเลย|ถูกต้อง|ใช่|confirm|yes/i;

/** A clear yes, with nothing that sounds like "not yet" or "change it". */
export function isClearYes(text: string): boolean {
  const clean = text.normalize("NFC").trim();
  if (!clean || clean.length > 40) return false;
  return AFFIRMATIVE.test(clean) && !NEGATIVE.test(clean);
}

export type RecipientCheck = { ok: true; recipient: Recipient } | { ok: false; missing: string[] };

export function checkRecipient(value: unknown): RecipientCheck {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const text = (key: string) => (typeof v[key] === "string" ? (v[key] as string).trim() : "");
  const recipient = { name: text("name"), phone: text("phone").replace(/[\s-]/g, ""), address: text("address"), postcode: text("postcode") };
  const missing: string[] = [];
  if (recipient.name.length < 1 || recipient.name.length > 200) missing.push("name");
  if (!/^(?:\+66|0)\d{8,9}$/.test(recipient.phone)) missing.push("phone");
  if (recipient.address.length < 5 || recipient.address.length > 500) missing.push("address");
  if (!/^\d{5}$/.test(recipient.postcode)) missing.push("postcode");
  return missing.length ? { ok: false, missing } : { ok: true, recipient };
}

export function checkLines(value: unknown, knownSkus: Set<string>): OrderLine[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ORDER_LINES) return null;
  const lines: OrderLine[] = [];
  for (const item of value) {
    const sku = (item as { sku?: unknown })?.sku;
    const qty = (item as { qty?: unknown })?.qty;
    if (typeof sku !== "string" || !knownSkus.has(sku)) return null;
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || qty > MAX_LINE_QTY) return null;
    lines.push({ sku, qty });
  }
  return lines;
}
