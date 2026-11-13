import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SLIP_RECEIVED_REPLY,
  SampleStockProvider,
  answerMessage,
  checkAnswer,
  checkRecipient,
  isClearYes,
  renderPayment,
  renderSummary,
  type BankDetails,
  type ModelAnswer,
  type ModelProvider,
  type ModelResponse,
  type OrderDraft,
  type OrderLine,
  type OrderQuote,
  type OrderingProvider,
  type Snapshot,
  type ToolCall,
} from "../src/index.ts";

// EXAMPLE data only.
const NOW = new Date("2026-11-13T05:00:00Z");
const snapshot: Snapshot = {
  products: [{ sku: "TK101", name: "TOKITI Nest", color: "Snow White", regular_price: 899, online_price: 590, booth_price: 490, spec_id: "nest" }],
  promotions: [],
  specs: [{ id: "nest", name: "Nest", size: null, weight_limit: null, pet_suitability: null, material: null, care: null, features: null }],
  faqs: [],
  settings: { enabled: true, bot_hours: { start: "00:00", end: "00:00" }, topics: ["price_promo", "order"], min_confidence: 0.5 },
};
const BANK: BankDetails = { bank_name: "EXAMPLE Bank", account: "000-0-00000-0", holder: "EXAMPLE SHOP" };
const RECIPIENT = { name: "EXAMPLE ผู้รับ", phone: "0800000000", address: "EXAMPLE 1 ถนนตัวอย่าง เขตตัวอย่าง", postcode: "10110" };

function quoteFor(lines: OrderLine[], fee = 50): OrderQuote {
  const quoted = lines.map((line) => ({ sku: line.sku, name: "TOKITI Nest", qty: line.qty, unit_price: 590, line_total: 590 * line.qty }));
  const subtotal = quoted.reduce((sum, line) => sum + line.line_total, 0);
  return { status: "ready", lines: quoted, subtotal, shipping_fee: fee, total: subtotal + fee, signature: `sig-${subtotal}-${fee}` };
}

function ordering(draft: OrderDraft | null, opts: { fee?: number; bank?: BankDetails | null; status?: string } = {}): OrderingProvider {
  return {
    quote: async (lines) => ({ ...quoteFor(lines, opts.fee), ...(opts.status ? { status: opts.status } : {}) }),
    current: async () => draft,
    bank: async () => (opts.bank === undefined ? BANK : opts.bank),
  };
}

function scripted(steps: { answer?: ModelAnswer; tool_calls?: ToolCall[] }[]): ModelProvider & { calls: number } {
  const model = {
    calls: 0,
    async complete(): Promise<ModelResponse> {
      const step = steps[model.calls++];
      if (!step) throw new Error("no scripted step");
      return { content: step.answer ? JSON.stringify(step.answer) : null, tool_calls: step.tool_calls ?? [], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 }, model: "test/model" };
    },
  };
  return model;
}

const call = (name: string, args: unknown): ToolCall => ({ id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const done: ModelAnswer = { action: "answer", topic: "order", reply_th: "EXAMPLE model text that must not be sent", source_ids: [], confidence: 0.9 };
const deps = (model: ModelProvider, provider: OrderingProvider) => ({
  snapshot,
  model,
  stock: new SampleStockProvider(async (skus) => skus.map((sku) => ({ sku, status: "in_stock" as const, restock_date: null }))),
  orders: { listForCustomer: async () => [] },
  ordering: provider,
  now: NOW,
});
const summaryDraft = (over: Partial<OrderDraft> = {}): OrderDraft => {
  const quote = quoteFor([{ sku: "TK101", qty: 2 }]);
  return { id: "draft-1", state: "summary_sent", lines: [{ sku: "TK101", qty: 2 }], recipient: RECIPIENT, quote, summary_text: renderSummary(quote, RECIPIENT), summary_is_latest: true, ...over };
};

test("a clear yes is short and has no hesitation", () => {
  for (const yes of ["ยืนยันค่ะ", "ตกลง", "โอเคค่ะ", "ok", "ได้ค่ะ", "เอาเลย", "สั่งเลยค่ะ", "ถูกต้องค่ะ"]) assert.ok(isClearYes(yes), yes);
  for (const no of ["ยังไม่เอา", "เดี๋ยวก่อนนะ", "ขอคิดก่อน", "ไม่ยืนยัน", "ขอเปลี่ยนสี", "ok แต่ขอแก้ที่อยู่", "ยกเลิก", "", "ยืนยันค่ะ ".repeat(10)]) assert.ok(!isClearYes(no), no);
});

test("a recipient needs a name, Thai phone, address and 5-digit postcode", () => {
  assert.ok(checkRecipient(RECIPIENT).ok);
  const bad = checkRecipient({ name: "", phone: "123", address: "x", postcode: "1011" });
  assert.deepEqual(!bad.ok && bad.missing, ["name", "phone", "address", "postcode"]);
});

test("a complete order sends the rendered summary, not the model's text", async () => {
  const model = scripted([{ tool_calls: [call("prepare_order_summary", { lines: [{ sku: "TK101", qty: 2 }], recipient: RECIPIENT })] }, { answer: done }]);
  const result = await answerMessage({ text: "ขอสั่ง Nest สีขาว 2 ชิ้น ส่ง EXAMPLE" }, "c1", deps(model, ordering(null)));
  assert.equal(result.order?.kind, "summary");
  assert.equal(result.action, "answer");
  assert.match(result.reply, /ยอดรวม 1,230 บาท/);
  assert.ok(!result.reply.includes("EXAMPLE model text"));
  assert.ok(!result.reply.includes(BANK.account), "no bank details before confirming");
});

test("missing recipient details go back to the model, which asks for them", async () => {
  const model = scripted([
    { tool_calls: [call("prepare_order_summary", { lines: [{ sku: "TK101", qty: 1 }], recipient: { ...RECIPIENT, phone: "" } })] },
    { answer: { action: "ask_followup", topic: "order", reply_th: "ขอเบอร์โทรผู้รับด้วยนะคะ", source_ids: [], confidence: 0.9 } },
  ]);
  const result = await answerMessage({ text: "ขอสั่ง Nest 1 ชิ้น" }, "c1", deps(model, ordering(null)));
  assert.equal(result.order, undefined);
  assert.equal(result.action, "ask_followup");
});

test("an unknown sku never reaches a quote", async () => {
  let quoted = false;
  const provider = { ...ordering(null), quote: async (lines: OrderLine[]) => ((quoted = true), quoteFor(lines)) };
  const model = scripted([{ tool_calls: [call("prepare_order_summary", { lines: [{ sku: "NOPE", qty: 1 }], recipient: RECIPIENT })] }, { answer: { ...done, action: "handoff" } }]);
  const result = await answerMessage({ text: "สั่งของ" }, "c1", deps(model, provider));
  assert.equal(quoted, false);
  assert.equal(result.order, undefined);
});

test("a yes to the latest summary sends payment details from settings", async () => {
  const model = scripted([{ tool_calls: [call("confirm_order", {})] }, { answer: done }]);
  const result = await answerMessage({ text: "ยืนยันค่ะ" }, "c1", deps(model, ordering(summaryDraft())));
  assert.equal(result.order?.kind, "confirm");
  assert.equal(result.reply, renderPayment(quoteFor([{ sku: "TK101", qty: 2 }]), BANK));
});

test("confirming needs a summary, the latest one, and a clear yes", async () => {
  const cases: [OrderDraft | null, string][] = [
    [null, "ยืนยันค่ะ"],
    [summaryDraft({ state: "collecting" }), "ยืนยันค่ะ"],
    [summaryDraft({ summary_is_latest: false }), "ยืนยันค่ะ"],
    [summaryDraft(), "เดี๋ยวก่อนนะคะ"],
  ];
  for (const [draft, text] of cases) {
    const model = scripted([{ tool_calls: [call("confirm_order", {})] }, { answer: { ...done, action: "ask_followup" } }]);
    const result = await answerMessage({ text }, "c1", deps(model, ordering(draft)));
    assert.equal(result.order, undefined, `${draft?.state} ${text}`);
    assert.ok(!result.reply.includes(BANK.account));
  }
});

test("a changed quote sends a new summary instead of payment details", async () => {
  const model = scripted([{ tool_calls: [call("confirm_order", {})] }, { answer: done }]);
  const result = await answerMessage({ text: "ยืนยันค่ะ" }, "c1", deps(model, ordering(summaryDraft(), { fee: 80 })));
  assert.equal(result.order?.kind, "summary");
  assert.match(result.reply, /ค่าส่ง 80 บาท/);
  assert.ok(!result.reply.includes(BANK.account));
});

test("no bank account in settings means no confirmation", async () => {
  const model = scripted([{ tool_calls: [call("confirm_order", {})] }, { answer: { ...done, action: "handoff" } }]);
  const result = await answerMessage({ text: "ยืนยันค่ะ" }, "c1", deps(model, ordering(summaryDraft(), { bank: null })));
  assert.equal(result.order, undefined);
  assert.equal(result.action, "handoff");
});

test("a model handoff cancels a pending order step", async () => {
  const model = scripted([{ tool_calls: [call("confirm_order", {})] }, { answer: { ...done, action: "handoff" } }]);
  const result = await answerMessage({ text: "ยืนยันค่ะ" }, "c1", deps(model, ordering(summaryDraft())));
  assert.equal(result.order, undefined);
  assert.equal(result.action, "handoff");
});

test("a picture while waiting for payment is recorded as the slip without the model", async () => {
  const model = scripted([]);
  const result = await answerMessage({ text: "", image_url: "data:image/jpeg;base64,EXAMPLE" }, "c1", deps(model, ordering(summaryDraft({ state: "awaiting_slip" }))));
  assert.equal(model.calls, 0);
  assert.deepEqual(result.order, { kind: "slip", draft_id: "draft-1" });
  assert.equal(result.reply, SLIP_RECEIVED_REPLY);
  assert.ok(!/ยืนยันการชำระ|ได้รับเงินแล้ว/.test(result.reply), "never confirms payment");
});

test("bank details written by the model are blocked", () => {
  const reasons = checkAnswer({
    answer: { action: "answer", topic: "order", reply_th: "โอนเข้าเลขบัญชี 123-4-56789-0 ได้เลยค่ะ", source_ids: ["product:TK101"], confidence: 0.9 },
    customerText: "โอนที่ไหน",
    sources: new Map([["product:TK101", "{}"]]),
    stockChecks: [],
    settings: snapshot.settings,
  });
  assert.ok(reasons.includes("bank_details_from_model"));
});
