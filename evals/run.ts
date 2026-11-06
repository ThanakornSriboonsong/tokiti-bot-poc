// Usage: npm run eval -- --models vendor/model-a,vendor/model-b [--limit 20]
// This spends OpenRouter credit. Check the case count before a full run.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  OpenRouterProvider,
  SampleStockProvider,
  answerMessage,
  extractPrices,
  type BotResult,
  type Order,
  type Snapshot,
  type StockStatus,
} from "@tokiti/core";
import { CASES, type EvalCase } from "./cases.ts";

try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  // Fall back to the shell environment.
}

const seedPath = fileURLToPath(new URL("../data/seed/sample.json", import.meta.url));
const seed = JSON.parse(readFileSync(seedPath, "utf8")) as Snapshot & {
  stock: { sku: string; status: StockStatus; restock_date: string | null }[];
  orders: (Order & { customer_id: string })[];
};
const NOW = new Date("2026-11-06T17:00:00Z");
const CONCURRENCY = 4;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

export function score(item: EvalCase, result: BotResult, allowedPrices: Set<string>): string[] {
  const failures: string[] = [];
  const reply = result.reply;
  if (item.expect === "handoff" && result.action !== "handoff") failures.push("should_hand_off");
  if (item.expect === "answer" && result.action !== "answer") failures.push("should_answer");
  if (item.expect === "answer_or_followup" && result.action === "handoff") failures.push("should_answer");
  if (result.action !== "handoff" && item.includes && !item.includes.some((value) => reply.includes(value))) failures.push("missing_expected_text");
  if (item.excludes?.some((value) => reply.includes(value))) failures.push("forbidden_text");
  if (extractPrices(reply).some((price) => !allowedPrices.has(price))) failures.push("wrong_price");
  return failures;
}

async function runModel(model: string, cases: EvalCase[], apiKey: string) {
  const provider = new OpenRouterProvider({ apiKey, model });
  const stock = new SampleStockProvider(async () => seed.stock);
  const orders = {
    listForCustomer: async (id: string) => seed.orders.filter((order) => order.customer_id === id),
  };
  const allowedPrices = new Set(
    extractPrices(`${JSON.stringify(seed.promotions)}`).concat(
      seed.products.flatMap((product) => [product.regular_price, product.online_price, product.booth_price].flatMap((value) => (value === null ? [] : [String(value)]))),
    ),
  );

  const rows: { item: EvalCase; result: BotResult; failures: string[] }[] = [];
  const queue = [...cases];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const result = await answerMessage({ text: item.text }, item.customer ?? "demo-a", { snapshot: seed, model: provider, stock, orders, now: NOW });
        rows.push({ item, result, failures: score(item, result, allowedPrices) });
      }
    }),
  );

  const latencies = rows.map((row) => row.result.latency_ms).sort((a, b) => a - b);
  const costs = rows.flatMap((row) => (row.result.usage.cost === null ? [] : [row.result.usage.cost]));
  const count = (failure: string) => rows.filter((row) => row.failures.includes(failure)).length;
  const answerable = rows.filter((row) => row.item.expect !== "handoff");
  return {
    summary: {
      model,
      cases: rows.length,
      passed: rows.filter((row) => row.failures.length === 0).length,
      wrong_price: count("wrong_price"),
      forbidden_text: count("forbidden_text"),
      missed_handoffs: count("should_hand_off"),
      answerable_rate: answerable.length ? answerable.filter((row) => row.failures.length === 0).length / answerable.length : 0,
      model_errors: rows.filter((row) => row.result.blocked_by.includes("model_error")).length,
      latency_p50_ms: latencies[Math.floor(latencies.length * 0.5)] ?? null,
      latency_p95_ms: latencies[Math.floor(latencies.length * 0.95)] ?? null,
      usd_per_1000: costs.length ? (costs.reduce((sum, value) => sum + value, 0) / costs.length) * 1000 : null,
    },
    failures: rows.filter((row) => row.failures.length > 0).map((row) => ({
      id: row.item.id,
      text: row.item.text,
      failures: row.failures,
      action: row.result.action,
      reply: row.result.reply,
      model_reply: row.result.model_reply,
      blocked_by: row.result.blocked_by,
      error: row.result.error,
    })),
    usage: {
      prompt_tokens: rows.reduce((sum, row) => sum + row.result.usage.prompt_tokens, 0),
      completion_tokens: rows.reduce((sum, row) => sum + row.result.usage.completion_tokens, 0),
      cost: costs.reduce((sum, value) => sum + value, 0),
    },
  };
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const models = (argument("models") ?? process.env.OPENROUTER_MODEL ?? "").split(",").filter(Boolean);
  const limit = Number(argument("limit") ?? CASES.length);
  if (!apiKey || models.length === 0) {
    console.error("Set OPENROUTER_API_KEY in .env and pass --models vendor/model-a,vendor/model-b");
    process.exit(1);
  }
  // Take evenly spaced cases, so a small run covers every topic rather than only prices.
  const step = Math.max(1, CASES.length / limit);
  const cases = Array.from({ length: Math.min(limit, CASES.length) }, (_, index) => CASES[Math.floor(index * step)]!);
  const outputDir = fileURLToPath(new URL("./results/", import.meta.url));
  mkdirSync(outputDir, { recursive: true });
  const summaries = [];
  for (const model of models) {
    console.log(`Running ${cases.length} cases on ${model}`);
    const report = await runModel(model, cases, apiKey);
    summaries.push(report.summary);
    writeFileSync(`${outputDir}${model.replaceAll("/", "__")}.json`, JSON.stringify(report, null, 2));
  }
  console.table(summaries);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
