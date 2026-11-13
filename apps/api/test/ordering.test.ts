import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelProvider, ModelResponse } from "@tokiti/core";
import { createApp } from "../src/app.ts";
import { openDb, seedDb } from "../src/db.ts";

// EXAMPLE data only. The scripted model orders or confirms when the customer asks to.
const NOON = new Date("2026-11-07T05:00:00Z");
type Json = Record<string, any>;
const RECIPIENT = { name: "EXAMPLE ผู้รับ", phone: "0800000000", address: "EXAMPLE 1 ถนนตัวอย่าง", postcode: "10110" };

const model: ModelProvider = {
  async complete(request): Promise<ModelResponse> {
    const base = { usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 }, model: "test/model" };
    const last = request.messages.at(-1);
    const customer = /<customer>([^<]*)<\/customer>/.exec(JSON.stringify(request.messages[1]))?.[1] ?? "";
    const done = { action: "answer", topic: "order", reply_th: "EXAMPLE model text", source_ids: [], confidence: 0.9 };
    if (last?.role === "tool") return { ...base, tool_calls: [], content: JSON.stringify(done) };
    const tool = (name: string, args: unknown) => ({ ...base, content: null, tool_calls: [{ id: "1", type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
    if (customer.includes("ขอสั่ง")) return tool("prepare_order_summary", { lines: [{ sku: "TK101", qty: 2 }], recipient: RECIPIENT });
    if (customer.includes("ยืนยัน")) return tool("confirm_order", {});
    return { ...base, tool_calls: [], content: JSON.stringify({ ...done, action: "ask_followup" }) };
  },
};

function setup() {
  const db = openDb(":memory:");
  seedDb(db);
  const app = createApp({ db, model, now: () => NOON });
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await app.request(path, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return { status: response.status, json: (await response.json()) as Json };
  };
  const draft = () => db.prepare("select state from order_drafts where customer_id = 'demo-a' and state <> 'cancelled'").get() as { state: string } | undefined;
  return { call, draft };
}

test("order, confirm and slip move forward only when staff send the exact rendered reply", async () => {
  const { call, draft } = setup();
  const summary = await call("/api/chat", "POST", { text: "ขอสั่ง Nest สีขาว 2 ชิ้น" });
  assert.equal(summary.json.result.order.kind, "summary");
  assert.match(summary.json.result.reply, /ยอดรวม 1,230 บาท/);
  assert.equal(draft(), undefined, "nothing stored before staff send it");

  const early = await call("/api/chat", "POST", { text: "ยืนยันค่ะ" });
  assert.equal(early.json.result.order, undefined, "a yes before the summary is sent confirms nothing");
  await call(`/api/queue/${early.json.id}/decision`, "POST", { decision: "reject" });

  assert.equal((await call(`/api/queue/${summary.json.id}/decision`, "POST", { decision: "approve" })).status, 200);
  assert.equal(draft()?.state, "summary_sent");

  const confirm = await call("/api/chat", "POST", { text: "ยืนยันค่ะ" });
  assert.equal(confirm.json.result.order.kind, "confirm");
  assert.match(confirm.json.result.reply, /000-0-00000-0/);
  assert.equal((await call(`/api/queue/${confirm.json.id}/decision`, "POST", { decision: "approve" })).status, 200);
  assert.equal(draft()?.state, "awaiting_slip");

  const slip = await call("/api/chat", "POST", { text: "", image_url: "data:image/jpeg;base64,EXAMPLE" });
  assert.equal(slip.json.result.order.kind, "slip");
  assert.equal((await call(`/api/queue/${slip.json.id}/decision`, "POST", { decision: "approve" })).status, 200);
  assert.equal(draft()?.state, "slip_received");

  // Approving the old confirmation again can't move the order: it was already decided.
  assert.equal((await call(`/api/queue/${confirm.json.id}/decision`, "POST", { decision: "approve" })).status, 409);
});

test("an edited summary changes nothing, and a reset cancels the open order", async () => {
  const { call, draft } = setup();
  const summary = await call("/api/chat", "POST", { text: "ขอสั่ง Nest สีขาว 2 ชิ้น" });
  await call(`/api/queue/${summary.json.id}/decision`, "POST", { decision: "edit", text: "EXAMPLE staff wording" });
  assert.equal(draft(), undefined);

  const again = await call("/api/chat", "POST", { text: "ขอสั่ง Nest สีขาว 2 ชิ้น" });
  await call(`/api/queue/${again.json.id}/decision`, "POST", { decision: "approve" });
  assert.equal(draft()?.state, "summary_sent");
  await call("/api/chat/reset", "POST", { customer_id: "demo-a" });
  assert.equal(draft(), undefined);
});
