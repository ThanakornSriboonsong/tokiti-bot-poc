// Usage: npm run eval:retrieval [-- --top-k 6]
// Checks whether retrieval finds the sources each test question needs. Word search only:
// no model call and no credit. Hybrid search needs embeddings, so judge it with `npm run eval -- --retrieval`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_TOP_K,
  LexicalRetriever,
  buildChunks,
  buildQuery,
  buildSources,
  customerRiskReasons,
  type Retriever,
  type Snapshot,
} from "@tokiti/core";
import { CASES, type EvalCase } from "./cases.ts";

const seedPath = fileURLToPath(new URL("../data/seed/sample.json", import.meta.url));
export const seed = JSON.parse(readFileSync(seedPath, "utf8")) as Snapshot;
export const NOW = new Date("2026-11-06T17:00:00Z");

/** What each group must find so the model can answer. Order tracking relies on tools instead. */
const NEEDS: Partial<Record<EvalCase["group"], { label: string; ok: (ids: string[]) => boolean }>> = {
  delivery: { label: "faq:shipping", ok: (ids) => ids.includes("faq:shipping") },
  size_weight: { label: "a spec", ok: (ids) => ids.some((id) => id.startsWith("spec:")) },
  price_promo: { label: "a product or promotion", ok: (ids) => ids.some((id) => /^(product|promo):/.test(id)) },
  // The model needs a SKU before it can call get_stock.
  stock_restock: { label: "a product", ok: (ids) => ids.some((id) => id.startsWith("product:")) },
  review: { label: "faq:reviews", ok: (ids) => ids.includes("faq:reviews") },
};

export interface RetrievalRow {
  id: string;
  text: string;
  hits: string[];
  missing: string[];
}

export async function retrievalReport(retriever: Retriever = new LexicalRetriever(), topK = DEFAULT_TOP_K) {
  const sources = buildSources(seed, NOW);
  const chunks = buildChunks(seed, NOW);
  const rows: RetrievalRow[] = [];

  for (const item of CASES) {
    // Rule-based handoffs stop before retrieval, so they need nothing.
    if (customerRiskReasons(item.text).length > 0) continue;
    const history = (item.history ?? []).map((text, index) => ({
      role: index % 2 === 0 ? ("customer" as const) : ("shop" as const),
      text,
      at: NOW.toISOString(),
    }));
    const { hits } = await retriever.search(chunks, buildQuery(item.text, history), topK);
    const ids = hits.map((hit) => hit.id);
    const missing: string[] = [];

    const need = item.history ? undefined : NEEDS[item.group];
    if (need && !need.ok(ids)) missing.push(need.label);

    // The reply needs only one of `includes`. If any of them can come from a tool (stock, orders),
    // retrieval isn't needed for it. Otherwise at least one value's source must come back.
    const includes = item.customer ? [] : (item.includes ?? []);
    const holders = includes.map((value) => [...sources].filter(([, text]) => text.includes(value)).map(([id]) => id));
    const specific = holders.every((ids) => ids.length > 0 && ids.length <= 3);
    if (includes.length > 0 && specific && !holders.some((group) => group.some((id) => ids.includes(id)))) {
      missing.push(includes.map((value, index) => `${value} (${holders[index]!.join("/")})`).join(" or "));
    }
    rows.push({ id: item.id, text: item.text, hits: ids, missing });
  }

  const checked = rows.length;
  const covered = rows.filter((row) => row.missing.length === 0).length;
  return {
    summary: {
      mode: retriever.mode,
      top_k: topK,
      cases: checked,
      covered,
      coverage: checked ? covered / checked : 1,
      avg_sources_sent: checked ? rows.reduce((sum, row) => sum + row.hits.length, 0) / checked : 0,
      total_sources: sources.size,
    },
    misses: rows.filter((row) => row.missing.length > 0),
    rows,
  };
}

async function main() {
  const index = process.argv.indexOf("--top-k");
  const topK = index === -1 ? DEFAULT_TOP_K : Number(process.argv[index + 1]);
  const report = await retrievalReport(new LexicalRetriever(), topK);
  console.table([report.summary]);
  for (const miss of report.misses) console.log(`MISS ${miss.id} "${miss.text}" needs ${miss.missing.join(", ")} got ${miss.hits.join(" ") || "(nothing)"}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
