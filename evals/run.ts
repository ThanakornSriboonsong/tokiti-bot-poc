// Usage: npm run eval -- --models vendor/model-a,vendor/model-b [--limit 20]
//        [--retrieval [--top-k 6] [--embedding-model vendor/embedding-model]]
// This spends OpenRouter credit. Check the case count before a full run.
// --retrieval sends only the matching sources; compare its result file with the one without it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  HybridRetriever,
  LexicalRetriever,
  OpenRouterEmbedder,
  OpenRouterProvider,
  type Retriever,
  SampleStockProvider,
  answerMessage,
  extractPrices,
  type BotResult,
  type Order,
  type OrderingProvider,
  renderSummary,
  type Snapshot,
  type StockStatus,
} from "@tokiti/core";
import { CASES, type EvalCase } from "./cases.ts";
import { EVAL_LINES, EVAL_RECIPIENT, ORDER_CASES, type OrderEvalCase } from "./ordering_cases.ts";
import { openDb, seedDb } from "../apps/api/src/db.ts";
import { getOrderingConfig, sampleOrdering } from "../apps/api/src/ordering.ts";

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

function averageCost(rows: { result: BotResult }[]): number | null {
  const costs = rows.flatMap((row) => (row.result.usage.cost === null ? [] : [row.result.usage.cost]));
  return costs.length ? (costs.reduce((sum, value) => sum + value, 0) / costs.length) * 1000 : null;
}

export function score(item: EvalCase | OrderEvalCase, result: BotResult, allowedPrices: Set<string>, bankAccount?: string): string[] {
  const failures: string[] = [];
  const reply = result.reply;
  const step = result.order?.kind ?? "none";
  if ("order" in item) {
    if (step === "confirm" && item.order !== "confirm") failures.push("unwanted_confirm");
    else if (item.order === "summary" || item.order === "confirm" ? step !== item.order : item.order === "none" && step !== "none") failures.push("order_step_mismatch");
  }
  if (bankAccount && reply.includes(bankAccount) && step !== "confirm") failures.push("bank_leak");
  // Totals in a rendered summary or payment message come from the quote, so they count as allowed.
  const quote = result.order && "quote" in result.order ? result.order.quote : null;
  if (quote) {
    allowedPrices = new Set([...allowedPrices, ...[quote.subtotal, quote.shipping_fee, quote.total, ...quote.lines.flatMap((line) => [line.unit_price, line.line_total])].map(String)]);
  }
  if (item.expect === "handoff" && result.action !== "handoff") failures.push("should_hand_off");
  if (item.expect === "answer" && result.action !== "answer") failures.push("should_answer");
  if (item.expect === "answer_or_followup" && result.action === "handoff") failures.push("should_answer");
  if (result.action !== "handoff" && item.includes && !item.includes.some((value) => reply.includes(value))) failures.push("missing_expected_text");
  if (item.excludes?.some((value) => reply.includes(value))) failures.push("forbidden_text");
  if (extractPrices(reply).some((price) => !allowedPrices.has(price))) failures.push("wrong_price");
  return failures;
}

interface RetrievalOption {
  retriever: Retriever;
  topK: number;
}

/** Sample ordering from the seed, with the case's existing order (if any) on file. */
function orderingFor(item: EvalCase | OrderEvalCase, snapshot: Snapshot): OrderingProvider {
  const db = openDb(":memory:");
  seedDb(db);
  const base = sampleOrdering(db, () => snapshot);
  const draft = "draft" in item ? item.draft : undefined;
  return {
    quote: base.quote,
    bank: base.bank,
    current: async () => {
      if (!draft) return null;
      const quote = await base.quote(EVAL_LINES, EVAL_RECIPIENT.postcode);
      return {
        id: "eval-draft",
        state: draft === "awaiting_slip" ? "awaiting_slip" : "summary_sent",
        lines: EVAL_LINES,
        recipient: EVAL_RECIPIENT,
        quote,
        summary_text: renderSummary(quote, EVAL_RECIPIENT),
        summary_is_latest: draft !== "summary_stale",
      };
    },
  };
}

async function runModel(model: string, cases: (EvalCase | OrderEvalCase)[], apiKey: string, retrieval?: RetrievalOption) {
  const snapshot: Snapshot = retrieval
    ? { ...seed, settings: { ...seed.settings, retrieval: { enabled: true, top_k: retrieval.topK } } }
    : { ...seed, settings: { ...seed.settings, retrieval: { enabled: false, top_k: 6 } } };
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

  const configDb = openDb(":memory:");
  seedDb(configDb);
  const bankAccount = getOrderingConfig(configDb).bank?.account;
  const orderingOn = snapshot.settings.ordering?.enabled === true;
  const rows: { item: EvalCase | OrderEvalCase; result: BotResult; failures: string[] }[] = [];
  const queue = [...cases];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const history = (item.history ?? []).map((text, index) => ({
          role: index % 2 === 0 ? ("customer" as const) : ("shop" as const),
          text,
          at: new Date(NOW.getTime() - 60_000).toISOString(),
        }));
        const result = await answerMessage({ text: item.text }, item.customer ?? "demo-a", {
          snapshot,
          model: provider,
          stock,
          orders,
          now: NOW,
          history,
          ...(retrieval ? { retriever: retrieval.retriever } : {}),
          ...(orderingOn ? { ordering: orderingFor(item, snapshot) } : {}),
        });
        rows.push({ item, result, failures: score(item, result, allowedPrices, bankAccount) });
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
      retrieval: retrieval ? `${retrieval.retriever.mode} top ${retrieval.topK}` : "all sources",
      model_searches: rows.reduce((sum, row) => sum + (row.result.retrieval?.searches ?? 0), 0),
      cases: rows.length,
      passed: rows.filter((row) => row.failures.length === 0).length,
      wrong_price: count("wrong_price"),
      ordering: orderingOn ? "on" : "off",
      unwanted_confirm: count("unwanted_confirm"),
      order_step_mismatch: count("order_step_mismatch"),
      bank_leak: count("bank_leak"),
      forbidden_text: count("forbidden_text"),
      missed_handoffs: count("should_hand_off"),
      answerable_rate: answerable.length ? answerable.filter((row) => row.failures.length === 0).length / answerable.length : 0,
      model_errors: rows.filter((row) => row.result.blocked_by.includes("model_error")).length,
      latency_p50_ms: latencies[Math.floor(latencies.length * 0.5)] ?? null,
      latency_p95_ms: latencies[Math.floor(latencies.length * 0.95)] ?? null,
      usd_per_1000: costs.length ? (costs.reduce((sum, value) => sum + value, 0) / costs.length) * 1000 : null,
      usd_per_1000_followups: averageCost(rows.filter((row) => row.item.history)),
      usd_per_1000_new_chats: averageCost(rows.filter((row) => !row.item.history)),
    },
    failures: rows.filter((row) => row.failures.length > 0).map((row) => ({
      id: row.item.id,
      text: row.item.text,
      failures: row.failures,
      action: row.result.action,
      order: row.result.order?.kind ?? null,
      tool_calls: row.result.tool_calls,
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
  const orderingOnly = process.argv.includes("--ordering");
  const pool: (EvalCase | OrderEvalCase)[] = orderingOnly ? ORDER_CASES : CASES;
  const limit = Number(argument("limit") ?? pool.length);
  if (!apiKey || models.length === 0) {
    console.error("Set OPENROUTER_API_KEY in .env and pass --models vendor/model-a,vendor/model-b");
    process.exit(1);
  }
  // Take evenly spaced cases, so a small run covers every topic rather than only prices.
  const step = Math.max(1, pool.length / limit);
  const cases = Array.from({ length: Math.min(limit, pool.length) }, (_, index) => pool[Math.floor(index * step)]!);
  const embeddingModel = argument("embedding-model");
  const retrieval: RetrievalOption | undefined = process.argv.includes("--retrieval")
    ? {
        retriever: embeddingModel
          ? new HybridRetriever(new OpenRouterEmbedder({ apiKey, model: embeddingModel }))
          : new LexicalRetriever(),
        topK: Number(argument("top-k") ?? 6),
      }
    : undefined;
  const outputDir = fileURLToPath(new URL("./results/", import.meta.url));
  mkdirSync(outputDir, { recursive: true });
  const summaries = [];
  for (const model of models) {
    console.log(`Running ${cases.length} cases on ${model}${retrieval ? ` with ${retrieval.retriever.mode} retrieval` : ""}`);
    const report = await runModel(model, cases, apiKey, retrieval);
    summaries.push(report.summary);
    const suffix = `${retrieval ? `__rag-${retrieval.retriever.mode}` : ""}${orderingOnly ? "__ordering" : ""}`;
    writeFileSync(`${outputDir}${model.replaceAll("/", "__")}${suffix}.json`, JSON.stringify(report, null, 2));
  }
  console.table(summaries);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
