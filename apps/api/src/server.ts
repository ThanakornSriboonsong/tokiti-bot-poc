import { serve } from "@hono/node-server";
import { OpenRouterProvider, TokitiStockProvider, type ModelProvider, type StockProvider } from "@tokiti/core";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { DB_PATH, openDb, seedDb } from "./db.ts";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  // .env is optional. Without a key, everything works except the bot itself.
}

const db = openDb(DB_PATH);
const seeded = db.prepare("select 1 from kv where key = 'published_version'").get();
if (!seeded) seedDb(db);

const { OPENROUTER_API_KEY, OPENROUTER_MODEL, OPENROUTER_FALLBACK_MODEL } = process.env;
const model: ModelProvider | null =
  OPENROUTER_API_KEY && OPENROUTER_MODEL
    ? new OpenRouterProvider({
        apiKey: OPENROUTER_API_KEY,
        model: OPENROUTER_MODEL,
        ...(OPENROUTER_FALLBACK_MODEL ? { fallbackModel: OPENROUTER_FALLBACK_MODEL } : {}),
      })
    : null;

let stock: StockProvider | undefined;
if (process.env.STOCK_PROVIDER === "tokiti") {
  const { TOKITI_STOCK_URL, TOKITI_STOCK_KEY } = process.env;
  if (!TOKITI_STOCK_URL || !TOKITI_STOCK_KEY) throw new Error("STOCK_PROVIDER=tokiti needs TOKITI_STOCK_URL and TOKITI_STOCK_KEY");
  stock = new TokitiStockProvider(TOKITI_STOCK_URL, TOKITI_STOCK_KEY);
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: createApp({ db, model, ...(stock ? { stock } : {}) }).fetch, port, hostname: "127.0.0.1" }, () => {
  console.log(`API on http://127.0.0.1:${port} (model ${model ? "configured" : "not configured"})`);
});
