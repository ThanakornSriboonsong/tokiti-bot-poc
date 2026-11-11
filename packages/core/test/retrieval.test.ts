import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  HybridRetriever,
  LexicalRetriever,
  OpenRouterEmbedder,
  SampleStockProvider,
  answerMessage,
  buildChunks,
  buildQuery,
  buildSources,
  tokenize,
  type Embedder,
  type ModelAnswer,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type Snapshot,
  type ToolCall,
} from "../src/index.ts";

const NOW = new Date("2026-11-06T17:00:00Z");
const seed = JSON.parse(readFileSync(fileURLToPath(new URL("../../../data/seed/sample.json", import.meta.url)), "utf8")) as Snapshot;
const withRetrieval = (enabled: boolean, top_k = 6): Snapshot => ({ ...seed, settings: { ...seed.settings, retrieval: { enabled, top_k } } });

const stock = new SampleStockProvider(async (skus) => skus.map((sku) => ({ sku, status: "in_stock" as const, restock_date: null })));
const orders = { listForCustomer: async () => [] };

function scripted(steps: (Partial<ModelResponse> & { answer?: ModelAnswer })[]): ModelProvider & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let index = 0;
  return {
    requests,
    async complete(request) {
      // Copy, because the pipeline keeps appending to the same message list.
      requests.push({ ...request, messages: [...request.messages] });
      const step = steps[index++];
      if (!step) throw new Error("no scripted step");
      return {
        content: step.answer ? JSON.stringify(step.answer) : (step.content ?? null),
        tool_calls: step.tool_calls ?? [],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
        model: "test/model",
      };
    },
  };
}

const call = (name: string, args: unknown): ToolCall => ({ id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const answer = (overrides: Partial<ModelAnswer>): ModelAnswer => ({
  action: "answer",
  topic: "price_promo",
  reply_th: "ราคา 590 บาทค่ะ",
  source_ids: ["product:TK101"],
  confidence: 0.9,
  ...overrides,
});
const systemText = (request: ModelRequest) => {
  const first = request.messages[0];
  return first?.role === "system" ? first.content : "";
};

test("Thai is split into words, and a colour joined to สี still finds the English name", () => {
  assert.deepEqual(tokenize("ที่นอนแมวราคา").slice(0, 3), ["ที่นอน", "แมว", "ราคา"]);
  const tokens = tokenize("สีชมพูมีไหม");
  assert.ok(tokens.includes("pink"), tokens.join("|"));
  assert.ok(tokenize("ราคา ๕๙๐").includes("590"));
});

test("chunks use the same ids as the sources and skip expired promotions", () => {
  const expired = { ...seed, promotions: [...seed.promotions, { id: "old", title: "Old", detail: "99 บาท", channel: "online" as const, starts_at: "2026-01-01", ends_at: "2026-02-01" }] };
  const ids = buildChunks(expired, NOW).map((chunk) => chunk.id).sort();
  assert.deepEqual(ids, [...buildSources(expired, NOW).keys()].sort());
  assert.ok(!ids.includes("promo:old"));
});

test("FAQ search keywords help search but never reach the model", () => {
  const source = buildSources(seed, NOW).get("faq:reviews")!;
  assert.ok(!source.includes("keywords"));
  assert.ok(buildChunks(seed, NOW).find((chunk) => chunk.id === "faq:reviews")!.text.includes("รีวิว"));
});

test("an alias finds the product, and its spec and other colours come along", async () => {
  const { hits } = await new LexicalRetriever().search(buildChunks(seed, NOW), "ตะกร้าแมวราคาเท่าไหร่", 6);
  const ids = hits.map((hit) => hit.id);
  assert.ok(ids.slice(0, 4).some((id) => id.startsWith("product:TK10")), ids.join(" "));
  for (const id of ["spec:nest", "product:TK101", "product:TK102", "product:TK103"]) assert.ok(ids.includes(id), `${id} in ${ids.join(" ")}`);
  assert.ok(!ids.includes("faq:payment"));
});

test("a short follow-up searches with the previous customer message", async () => {
  const query = buildQuery("แล้วมีของไหม", [
    { role: "customer", text: "ไม้ตกแมวราคาเท่าไหร่", at: NOW.toISOString() },
    { role: "shop", text: "134 บาทค่ะ", at: NOW.toISOString() },
  ]);
  const { hits } = await new LexicalRetriever().search(buildChunks(seed, NOW), query, 6);
  assert.equal(hits[0]?.id, "product:TK301");
});

test("retrieval off keeps the old behaviour: every source, no search tool", async () => {
  const model = scripted([{ answer: answer({}) }]);
  const result = await answerMessage({ text: "ที่นอนแมวราคาเท่าไหร่" }, "demo-a", { snapshot: withRetrieval(false), model, stock, orders, now: NOW });
  assert.equal(result.action, "answer");
  assert.equal(result.retrieval, undefined);
  assert.ok(systemText(model.requests[0]!).includes("[faq:payment]"));
  assert.ok(!model.requests[0]!.tools.some((tool) => tool.function.name === "search_knowledge"));
});

test("retrieval on sends only matching sources and reports them", async () => {
  const model = scripted([{ answer: answer({}) }]);
  const result = await answerMessage({ text: "ที่นอนแมวราคาเท่าไหร่" }, "demo-a", { snapshot: withRetrieval(true), model, stock, orders, now: NOW });
  const prompt = systemText(model.requests[0]!);
  assert.equal(result.action, "answer", result.blocked_by.join(","));
  assert.ok(prompt.includes("[product:TK101]"));
  assert.ok(!prompt.includes("[faq:payment]"));
  assert.ok(prompt.includes("search_knowledge"));
  assert.equal(result.retrieval?.mode, "lexical");
  assert.ok(result.retrieval!.hits.some((hit) => hit.id === "product:TK101"));
});

test("citing a source the model was not shown goes to staff", async () => {
  const model = scripted([{ answer: answer({ reply_th: "ดูได้ที่ลิงก์ค่ะ", topic: "other", source_ids: ["faq:payment"] }) }]);
  const result = await answerMessage({ text: "ที่นอนแมวราคาเท่าไหร่" }, "demo-a", { snapshot: withRetrieval(true), model, stock, orders, now: NOW });
  assert.equal(result.action, "handoff");
  assert.ok(result.blocked_by.includes("unknown_source"));
});

test("search_knowledge shows more sources, which can then be cited", async () => {
  const model = scripted([
    { tool_calls: [call("search_knowledge", { query: "ไม้ตกแมว ราคา" })] },
    { answer: answer({ reply_th: "ไม้ตกแมว 134 บาทค่ะ", source_ids: ["product:TK301"] }) },
  ]);
  const result = await answerMessage({ text: "ส่งกี่วันคะ" }, "demo-a", { snapshot: withRetrieval(true), model, stock, orders, now: NOW });
  assert.ok(!systemText(model.requests[0]!).includes("[product:TK301]"));
  const toolMessage = model.requests[1]!.messages.at(-1)!;
  assert.ok(toolMessage.role === "tool" && toolMessage.content.includes("product:TK301"));
  assert.equal(result.action, "answer", result.blocked_by.join(","));
  assert.equal(result.retrieval?.searches, 1);
});

test("an order lookup brings the tracking FAQ even when search missed it", async () => {
  const model = scripted([
    { tool_calls: [call("get_my_orders", {})] },
    { answer: answer({ topic: "order_tracking", reply_th: "ดูออเดอร์ได้ที่ลิงก์ค่ะ", source_ids: ["faq:track"] }) },
  ]);
  const result = await answerMessage({ text: "ที่นอนแมวราคาเท่าไหร่" }, "demo-none", { snapshot: withRetrieval(true), model, stock, orders, now: NOW });
  assert.equal(result.action, "answer", result.blocked_by.join(","));
});

test("a photo with no text sends every source", async () => {
  const model = scripted([{ answer: answer({ topic: "image", reply_th: "เห็นที่นอนแมวค่ะ", source_ids: ["spec:nest"] }) }]);
  const result = await answerMessage({ text: "", image_url: "data:image/png;base64,AAAA" }, "demo-a", { snapshot: withRetrieval(true), model, stock, orders, now: NOW });
  assert.equal(result.retrieval?.sent_all, true);
  assert.ok(systemText(model.requests[0]!).includes("[faq:payment]"));
});

test("a greeting that matches nothing gets every source and the normal prompt", async () => {
  const model = scripted([{ answer: answer({ topic: "other", reply_th: "สวัสดีค่ะ", source_ids: ["faq:ordering"] }) }]);
  const result = await answerMessage({ text: "สวัสดีค่ะ" }, "demo-a", { snapshot: withRetrieval(true), model, stock, orders, now: NOW });
  assert.equal(result.retrieval?.sent_all, true);
  assert.ok(systemText(model.requests[0]!).includes("[faq:payment]"));
  assert.ok(!systemText(model.requests[0]!).includes("search_knowledge"));
  assert.ok(!model.requests[0]!.tools.some((tool) => tool.function.name === "search_knowledge"));
});

test("the retrieval rules tell the model the sources it got are approved and usable", async () => {
  const model = scripted([{ answer: answer({}) }]);
  await answerMessage({ text: "ที่นอนแมวราคาเท่าไหร่" }, "demo-a", { snapshot: withRetrieval(true), model, stock, orders, now: NOW });
  const prompt = systemText(model.requests[0]!);
  assert.ok(prompt.includes("ใช้ตอบได้ทันที"));
  assert.ok(!prompt.includes("ไม่ใช่ข้อมูลทั้งหมด"));
});

test("rule-based handoffs stop before retrieval", async () => {
  let searched = false;
  const retriever = { mode: "lexical" as const, search: async () => ((searched = true), { hits: [] }) };
  const result = await answerMessage({ text: "ขอคืนเงินค่ะ" }, "demo-a", { snapshot: withRetrieval(true), model: scripted([]), stock, orders, now: NOW, retriever });
  assert.equal(result.action, "handoff");
  assert.equal(searched, false);
});

test("a retriever that throws falls back to every source", async () => {
  const retriever = { mode: "hybrid" as const, search: async () => Promise.reject(new Error("boom")) };
  const model = scripted([{ answer: answer({}) }]);
  const result = await answerMessage({ text: "ที่นอนแมวราคาเท่าไหร่" }, "demo-a", { snapshot: withRetrieval(true), model, stock, orders, now: NOW, retriever });
  assert.match(result.retrieval?.error ?? "", /retrieval_failed: boom/);
  assert.ok(systemText(model.requests[0]!).includes("[faq:payment]"));
});

/** Each text becomes a vector of which topic words it contains, which is enough to rank by meaning. */
function fakeEmbedder(): Embedder & { calls: string[][] } {
  const axes = ["ส่ง", "ราคา", "รีวิว", "แมว"];
  const calls: string[][] = [];
  return {
    calls,
    async embed(texts) {
      calls.push(texts);
      return texts.map((text) => axes.map((axis) => (text.includes(axis) ? 1 : 0.01)));
    },
  };
}

test("hybrid search fuses word and vector ranks and caches source vectors", async () => {
  const embedder = fakeEmbedder();
  const retriever = new HybridRetriever(embedder);
  const chunks = buildChunks(seed, NOW);
  const first = await retriever.search(chunks, "ส่งกี่วัน", 4);
  assert.equal(first.hits[0]?.id, "faq:shipping");
  assert.ok(first.hits[0]!.via.includes("lexical") && first.hits[0]!.via.includes("vector"));
  await retriever.search(chunks, "รีวิวดีไหม", 4);
  assert.equal(embedder.calls[0]!.length, chunks.length + 1);
  assert.deepEqual(embedder.calls[1], ["รีวิวดีไหม"]);
});

test("hybrid search falls back to words when embedding fails", async () => {
  const retriever = new HybridRetriever({ embed: async () => Promise.reject(new Error("embedding_error: 402")) });
  const result = await retriever.search(buildChunks(seed, NOW), "ส่งกี่วัน", 4);
  assert.equal(result.hits[0]?.id, "faq:shipping");
  assert.match(result.error ?? "", /402/);
});

test("embedding errors never expose the API key", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    throw new TypeError(`bad header ${String((init?.headers as Record<string, string>).authorization)}`);
  }) as typeof fetch;
  try {
    await assert.rejects(new OpenRouterEmbedder({ apiKey: "sk-secret-value", model: "x/y" }).embed(["a"]), (error: Error) => {
      assert.ok(!error.message.includes("sk-secret-value"));
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});
