import type { BotResult, Snapshot, StockStatus } from "@tokiti/core";

export type { BotResult, Snapshot, StockStatus };

export class ApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.error ?? status));
    this.status = status;
    this.body = body;
  }
}

export async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new ApiError(response.status, json);
  return json as T;
}

export interface StockRow {
  sku: string;
  status: StockStatus;
  restock_date: string | null;
}

export interface QueueItem {
  id: number;
  customer_id: string;
  text: string;
  has_image: number;
  version_id: number | null;
  result: BotResult;
  status: "pending" | "approved" | "edited" | "rejected";
  final_text: string | null;
  reason: string | null;
  stock_flag: { sku: string; was: string; now: string }[] | null;
  created_at: string;
}

export interface Telemetry {
  total: number;
  handoff_rate: number;
  by_topic: { name: string; total: number }[];
  handoff_reasons: { name: string; total: number }[];
  decisions: { name: string; total: number }[];
  approval_rate: number | null;
  safety_blocks: number;
  latency_ms: { p50: number | null; p95: number | null };
  tokens: number;
  cost_usd: number | null;
  stock_reads: { total: number; failed: number | null; avg_ms: number | null };
  unanswered: { id: number; text: string; topic: string; reasons: string[] }[];
}

export interface Versions {
  current: number;
  versions: { id: number; note: string | null; created_at: string }[];
}

export const TOPIC_LABELS: Record<string, string> = {
  price_promo: "ราคาและโปรโมชั่น",
  delivery: "ระยะเวลาจัดส่ง",
  size_weight: "ขนาดและน้ำหนัก",
  stock_restock: "สต๊อกและของเข้า",
  order_tracking: "ติดตามออเดอร์",
  image: "รูปจากลูกค้า",
  review: "รีวิวสินค้า",
  risky: "เรื่องเสี่ยง",
  other: "อื่น ๆ",
};

export const REASON_LABELS: Record<string, string> = {
  risky_customer_text: "ลูกค้าพูดถึงเรื่องเสี่ยง",
  risky_topic: "เรื่องเสี่ยง",
  payment_claim: "ลูกค้าแจ้งว่าจ่ายเงินแล้ว",
  prompt_injection: "พยายามสั่งบอทหรือขอข้อมูลระบบ",
  other_customer_data: "ขอข้อมูลลูกค้าคนอื่น",
  typed_order_code: "พิมพ์เลขออเดอร์เอง",
  delivery_deadline: "ขอให้ยืนยันวันส่ง",
  topic_disabled: "ปิดหัวข้อนี้อยู่",
  low_confidence: "ความมั่นใจต่ำ",
  unknown_source: "อ้างข้อมูลที่ไม่มีหรือหมดอายุ",
  no_source: "ไม่มีแหล่งข้อมูล",
  price_not_in_source: "ราคาไม่ตรงข้อมูล",
  number_not_in_source: "ตัวเลขไม่ตรงข้อมูล",
  promise_refund: "สัญญาคืนเงิน",
  promise_payment: "ยืนยันการชำระเงิน",
  promise_delivery: "สัญญาวันส่ง",
  promise_claim: "กล่าวอ้างเกินจริง",
  wrong_product_name: "ใช้ชื่อสินค้าผิด",
  internal_term: "ใช้คำศัพท์ระบบ",
  stock_without_live_read: "ตอบสต๊อกโดยไม่อ่านข้อมูลล่าสุด",
  stock_unknown: "อ่านสต๊อกไม่สำเร็จ",
  invalid_model_output: "คำตอบจากโมเดลอ่านไม่ได้",
  model_error: "เรียกโมเดลไม่สำเร็จ",
  too_many_tool_rounds: "เรียกเครื่องมือหลายรอบเกินไป",
  model_chose_handoff: "ไม่มีข้อมูลพอ",
};

export const STOCK_LABELS: Record<StockStatus, string> = {
  in_stock: "มีของ",
  out_of_stock: "ของหมด",
  on_hold: "พักการขาย",
  count_pending: "รอนับสต๊อก",
  unknown: "ไม่ทราบ",
};
