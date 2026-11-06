import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelProvider, ModelResponse, Snapshot } from "@tokiti/core";
import { createApp } from "../src/app.ts";
import { openDb, seedDb } from "../src/db.ts";

const NIGHT = new Date("2026-11-06T17:00:00Z"); // 00:00 in Bangkok
const NOON = new Date("2026-11-07T05:00:00Z"); // 12:00 in Bangkok

type Json = Record<string, any>;

/** Scripted model: quotes whichever Duo price is in its prompt, and reads stock when asked. */
const model: ModelProvider = {
  async complete(request): Promise<ModelResponse> {
    const base = { usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.002 }, model: "test/model" };
    const last = request.messages.at(-1);
    const prompt = JSON.stringify(request.messages);
    if (prompt.includes("มีของไหม") && last?.role !== "tool") {
      return { ...base, content: null, tool_calls: [{ id: "1", type: "function", function: { name: "get_stock", arguments: '{"skus":["TK101"]}' } }] };
    }
    if (last?.role === "tool") {
      const available = last.content.includes('"status":"in_stock"');
      const reply = available ? "มีของค่ะ" : "ตอนนี้สินค้าหมดค่ะ";
      return { ...base, tool_calls: [], content: JSON.stringify({ action: "answer", topic: "stock_restock", reply_th: reply, source_ids: ["stock:TK101"], confidence: 0.9 }) };
    }
    const hasFlash = prompt.includes("flash-sale");
    const reply = hasFlash ? "ลดเหลือ 500 บาทค่ะ" : "Duo 749 บาทค่ะ";
    const source = hasFlash ? "promo:flash-sale" : "promo:duo-set";
    return { ...base, tool_calls: [], content: JSON.stringify({ action: "answer", topic: "price_promo", reply_th: reply, source_ids: [source], confidence: 0.9 }) };
  },
};

function setup(now = NIGHT) {
  const db = openDb(":memory:");
  seedDb(db);
  const app = createApp({ db, model, now: () => now });
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await app.request(path, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return { status: response.status, json: (await response.json()) as Json };
  };
  return { call };
}

test("publish, preview and rollback change what the bot uses", async () => {
  const { call } = setup();
  assert.match((await call("/api/chat", "POST", { text: "มีโปรไหม" })).json.result.reply, /749/);

  const draft = (await call("/api/draft")).json as Snapshot;
  draft.promotions.push({ id: "flash-sale", title: "Flash", detail: "ราคา 500 บาท", channel: "online", starts_at: null, ends_at: null });
  await call("/api/draft", "PUT", draft);

  assert.match((await call("/api/chat", "POST", { text: "มีโปรไหม", preview: true })).json.result.reply, /500/);
  assert.match((await call("/api/chat", "POST", { text: "มีโปรไหม" })).json.result.reply, /749/);

  const published = (await call("/api/publish", "POST", { note: "flash" })).json;
  const after = await call("/api/chat", "POST", { text: "มีโปรไหม" });
  assert.match(after.json.result.reply, /500/);
  assert.equal(after.json.version_id, published.id);

  await call(`/api/rollback/${published.id - 1}`, "POST");
  assert.match((await call("/api/chat", "POST", { text: "มีโปรไหม" })).json.result.reply, /749/);
});

test("a stock change applies on the next message with no publish", async () => {
  const { call } = setup();
  assert.match((await call("/api/chat", "POST", { text: "มีของไหม" })).json.result.reply, /มีของ/);
  await call("/api/stock/TK101", "PUT", { status: "out_of_stock" });
  assert.match((await call("/api/chat", "POST", { text: "มีของไหม" })).json.result.reply, /หมด/);
});

test("a failed stock status goes to staff", async () => {
  const { call } = setup();
  await call("/api/stock/TK101", "PUT", { status: "unknown" });
  const { json } = await call("/api/chat", "POST", { text: "มีของไหม" });
  assert.equal(json.result.action, "handoff");
  assert.ok(json.result.blocked_by.includes("stock_unknown"));
});

test("approval rechecks stock and flags a change", async () => {
  const { call } = setup();
  const { id } = (await call("/api/chat", "POST", { text: "มีของไหม" })).json;
  await call("/api/stock/TK101", "PUT", { status: "out_of_stock" });

  const refused = await call(`/api/queue/${id}/decision`, "POST", { decision: "approve" });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error, "stock_changed");

  const edited = await call(`/api/queue/${id}/decision`, "POST", { decision: "edit", text: "ตอนนี้ของหมดค่ะ" });
  assert.equal(edited.json.status, "edited");
  const again = await call(`/api/queue/${id}/decision`, "POST", { decision: "approve" });
  assert.equal(again.status, 409);
  assert.equal(again.json.error, "already_decided");
});

test("bot hours gate the bot when requested", async () => {
  const { call } = setup(NOON);
  assert.equal((await call("/api/chat", "POST", { text: "มีโปรไหม", respect_hours: true })).json.skipped, "outside_bot_hours");
});

test("telemetry reports decisions, gaps and stock reads", async () => {
  const { call } = setup();
  const { id } = (await call("/api/chat", "POST", { text: "มีโปรไหม" })).json;
  await call(`/api/queue/${id}/decision`, "POST", { decision: "approve" });
  await call("/api/stock/TK101", "PUT", { status: "unknown" });
  await call("/api/chat", "POST", { text: "มีของไหม" });

  const { json } = await call("/api/telemetry");
  assert.equal(json.total, 2);
  assert.equal(json.handoff_rate, 0.5);
  assert.equal(json.approval_rate, 1);
  assert.equal(json.unanswered[0].text, "มีของไหม");
  assert.equal(json.stock_reads.total, 1);
  assert.equal(json.stock_reads.failed, 1);
});

test("follow-ups see earlier messages, but only replies the customer received", async () => {
  const db = openDb(":memory:");
  seedDb(db);
  const prompts: string[] = [];
  const recording: ModelProvider = {
    complete: async (request) => {
      prompts.push(JSON.stringify(request.messages.at(-1)));
      return model.complete(request);
    },
  };
  const app = createApp({ db, model: recording, now: () => NIGHT });
  const post = async (path: string, body: unknown) => {
    const response = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await response.json()) as Json;
  };

  const first = await post("/api/chat", { text: "มีโปรไหม", customer_id: "demo-a" });
  const second = await post("/api/chat", { text: "ขอดูอีกที", customer_id: "demo-a" });
  assert.match(prompts[1]!, /มีโปรไหม/);
  assert.doesNotMatch(prompts[1]!, /749/, "a pending draft was never sent");
  assert.equal(second.result.history_count, 1);

  await post(`/api/queue/${first.id}/decision`, { decision: "approve" });
  await post(`/api/queue/${second.id}/decision`, { decision: "reject" });
  await post("/api/chat", { text: "แล้วราคาเท่าไหร่", customer_id: "demo-a" });
  assert.match(prompts[2]!, /749/, "an approved reply was sent");
  assert.equal(prompts[2]!.split("749").length, 2, "a rejected draft stays out");

  await post("/api/chat", { text: "อีกคน", customer_id: "demo-b" });
  assert.doesNotMatch(prompts[3]!, /มีโปรไหม/, "chats stay separate per customer");

  await post("/api/chat/reset", { customer_id: "demo-a" });
  const fresh = await post("/api/chat", { text: "เริ่มใหม่", customer_id: "demo-a" });
  assert.equal(fresh.result.history_count, 0);
});

test("a password protects everything except the health check", async () => {
  const db = openDb(":memory:");
  seedDb(db);
  const app = createApp({ db, model, password: "secret-test-value" });
  const login = { authorization: `Basic ${btoa("tokiti:secret-test-value")}` };
  const wrong = { authorization: `Basic ${btoa("tokiti:wrong")}` };

  assert.equal((await app.request("/healthz")).status, 200);
  assert.equal((await app.request("/api/status")).status, 401);
  assert.equal((await app.request("/api/status", { headers: wrong })).status, 401);
  assert.equal((await app.request("/api/status", { headers: login })).status, 200);
  assert.equal((await app.request("/anything")).status, 401);
});

test("the daily chat limit stops further model calls", async () => {
  const db = openDb(":memory:");
  seedDb(db);
  const app = createApp({ db, model, now: () => NIGHT, dailyChatLimit: 1 });
  const ask = () => app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "มีโปรไหม" }) });
  assert.equal((await ask()).status, 200);
  assert.equal((await ask()).status, 429);
});

test("the bot reports when no model is configured", async () => {
  const db = openDb(":memory:");
  seedDb(db);
  const response = await createApp({ db, model: null }).request("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "สวัสดี" }),
  });
  assert.equal(response.status, 503);
});
