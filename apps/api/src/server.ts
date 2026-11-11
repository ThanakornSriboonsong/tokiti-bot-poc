import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  HybridRetriever,
  OpenRouterEmbedder,
  OpenRouterProvider,
  TokitiStockProvider,
  type ModelProvider,
  type Retriever,
  type StockProvider,
} from "@tokiti/core";
import { existsSync } from "node:fs";
import { relative } from "node:path";
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

// Word search needs no key. With an embedding model it also ranks by meaning (costs a little credit).
const { OPENROUTER_EMBEDDING_MODEL } = process.env;
const retriever: Retriever | undefined =
  OPENROUTER_API_KEY && OPENROUTER_EMBEDDING_MODEL
    ? new HybridRetriever(new OpenRouterEmbedder({ apiKey: OPENROUTER_API_KEY, model: OPENROUTER_EMBEDDING_MODEL }))
    : undefined;

let stock: StockProvider | undefined;
if (process.env.STOCK_PROVIDER === "tokiti") {
  const { TOKITI_STOCK_URL, TOKITI_STOCK_KEY } = process.env;
  if (!TOKITI_STOCK_URL || !TOKITI_STOCK_KEY) throw new Error("STOCK_PROVIDER=tokiti needs TOKITI_STOCK_URL and TOKITI_STOCK_KEY");
  stock = new TokitiStockProvider(TOKITI_STOCK_URL, TOKITI_STOCK_KEY);
}

const hostname = process.env.HOST ?? "127.0.0.1";
const password = process.env.APP_PASSWORD;
const isLocal = hostname === "127.0.0.1" || hostname === "localhost";
if (!isLocal && !password) throw new Error("APP_PASSWORD is required when HOST is not local");

const dailyChatLimit = process.env.DAILY_CHAT_LIMIT ? Number(process.env.DAILY_CHAT_LIMIT) : undefined;
const app = createApp({
  db,
  model,
  ...(stock ? { stock } : {}),
  ...(password ? { password } : {}),
  ...(dailyChatLimit === undefined ? {} : { dailyChatLimit }),
  ...(retriever ? { retriever } : {}),
});

// A hosted copy serves the built control web from this one server.
const webRoot = relative(process.cwd(), fileURLToPath(new URL("../../web/dist", import.meta.url))).replaceAll("\\", "/");
if (existsSync(webRoot)) {
  app.use("/*", serveStatic({ root: webRoot }));
  app.get("*", serveStatic({ path: `${webRoot}/index.html` }));
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(`API on http://${hostname}:${port} (model ${model ? "configured" : "not configured"})`);
});
