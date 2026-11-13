import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import {
  MAX_HISTORY_TURNS,
  SampleStockProvider,
  answerMessage,
  bangkokDate,
  gateReason,
  recheckStock,
  type BotResult,
  type HistoryTurn,
  type ModelProvider,
  type Order,
  type OrderProvider,
  type Retriever,
  type Snapshot,
  type StockItem,
  type StockProvider,
  type StockStatus,
} from "@tokiti/core";
import { getDraft, getPublished, publish, rollback, setDraft } from "./db.ts";
import { applyOrderEffect, cancelOpenDrafts, sampleOrdering } from "./ordering.ts";

const MAX_IMAGE_CHARS = 7_000_000; // about 5 MB once base64-encoded
const STOCK_STATUSES: StockStatus[] = ["in_stock", "out_of_stock", "on_hold", "count_pending", "unknown"];

export interface AppDeps {
  db: DatabaseSync;
  model: ModelProvider | null;
  stock?: StockProvider;
  now?: () => Date;
  /** Required on any hosted copy. Login is the username `tokiti` with this password. */
  password?: string;
  /** Caps bot calls per Bangkok day, so a shared link can't drain the OpenRouter credit. */
  dailyChatLimit?: number;
  /** Used when the published settings turn retrieval on. Defaults to word search. */
  retriever?: Retriever;
}

export function sampleStock(db: DatabaseSync): StockProvider {
  return new SampleStockProvider(async (skus) => {
    const rows = db.prepare("select sku, status, restock_date from stock").all() as unknown as Omit<StockItem, "checked_at">[];
    return rows.filter((row) => skus.includes(row.sku));
  });
}

/** Records every stock read for telemetry, without changing what the caller sees. */
function loggedStock(db: DatabaseSync, inner: StockProvider): StockProvider {
  return {
    async getStock(skus) {
      const started = Date.now();
      let items: StockItem[] = [];
      try {
        items = await inner.getStock(skus);
        return items;
      } finally {
        db.prepare("insert into stock_reads(skus, statuses, latency_ms, created_at) values (?, ?, ?, ?)").run(
          skus.join(","),
          items.length > 0 ? items.map((item) => item.status).join(",") : "error",
          Date.now() - started,
          new Date().toISOString(),
        );
      }
    },
  };
}

function orderProvider(db: DatabaseSync): OrderProvider {
  return {
    async listForCustomer(customerId) {
      return db
        .prepare("select code, state, carrier, tracking from orders where customer_id = ?")
        .all(customerId) as unknown as Order[];
    },
  };
}

/**
 * Customer messages always count. A shop reply counts only once staff approve or edit it,
 * because the customer never sees a pending or rejected draft.
 */
function loadHistory(db: DatabaseSync, customerId: string): HistoryTurn[] {
  const reset = db.prepare("select value from kv where key = ?").get(`history_reset:${customerId}`) as { value: string } | undefined;
  const rows = db
    .prepare("select * from replies where customer_id = ? and created_at > ? order by id desc limit ?")
    .all(customerId, reset?.value ?? "", MAX_HISTORY_TURNS) as unknown as ReplyRow[];
  return rows.reverse().flatMap((row) => {
    const customer: HistoryTurn = { role: "customer", text: row.text || "(ส่งรูป)", at: row.created_at };
    if (row.final_text === null) return [customer];
    return [customer, { role: "shop", text: row.final_text, at: row.decided_at ?? row.created_at } satisfies HistoryTurn];
  });
}

interface ReplyRow {
  id: number;
  customer_id: string;
  text: string;
  has_image: number;
  version_id: number | null;
  result: string;
  status: string;
  final_text: string | null;
  reason: string | null;
  stock_flag: string | null;
  created_at: string;
  decided_at: string | null;
}

const toReply = (row: ReplyRow) => ({
  ...row,
  result: JSON.parse(row.result) as BotResult,
  stock_flag: row.stock_flag ? JSON.parse(row.stock_flag) : null,
});

export function createApp({ db, model, stock, now = () => new Date(), password, dailyChatLimit, retriever }: AppDeps) {
  const app = new Hono();
  const stockProvider = loggedStock(db, stock ?? sampleStock(db));
  const orders = orderProvider(db);
  const ordering = sampleOrdering(db, () => getPublished(db).snapshot);
  const chatsByDay = new Map<string, number>();

  // Render's health check can't log in, so this one route stays open and reveals nothing.
  app.get("/healthz", (c) => c.text("ok"));

  if (password) app.use("*", basicAuth({ username: "tokiti", password }));

  app.get("/api/status", (c) =>
    c.json({
      model_configured: model !== null,
      published_version: getPublished(db).id,
      retrieval_mode: retriever?.mode ?? "lexical",
    }),
  );

  app.get("/api/draft", (c) => c.json(getDraft(db)));
  app.put("/api/draft", async (c) => {
    setDraft(db, (await c.req.json()) as Snapshot);
    return c.json({ ok: true });
  });

  app.get("/api/versions", (c) => {
    const current = getPublished(db).id;
    const rows = db.prepare("select id, note, created_at from versions order by id desc").all();
    return c.json({ current, versions: rows });
  });
  app.post("/api/publish", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { note?: string };
    return c.json({ id: publish(db, body.note ?? null) });
  });
  app.post("/api/rollback/:id", (c) => {
    const ok = rollback(db, Number(c.req.param("id")));
    return ok ? c.json({ ok }) : c.json({ error: "version_not_found" }, 404);
  });

  app.get("/api/stock", (c) => c.json(db.prepare("select sku, status, restock_date from stock order by sku").all()));
  app.put("/api/stock/:sku", async (c) => {
    const body = (await c.req.json()) as { status: StockStatus; restock_date?: string | null };
    if (!STOCK_STATUSES.includes(body.status)) return c.json({ error: "invalid_status" }, 400);
    db.prepare("update stock set status = ?, restock_date = ? where sku = ?").run(
      body.status,
      body.restock_date ?? null,
      c.req.param("sku"),
    );
    return c.json({ ok: true });
  });

  app.post("/api/chat", async (c) => {
    const body = (await c.req.json()) as {
      text?: string;
      image_url?: string;
      customer_id?: string;
      preview?: boolean;
      respect_hours?: boolean;
    };
    const text = body.text?.trim() ?? "";
    if (!text && !body.image_url) return c.json({ error: "empty_message" }, 400);
    if (body.image_url && body.image_url.length > MAX_IMAGE_CHARS) return c.json({ error: "image_too_large" }, 413);
    if (!model) return c.json({ error: "model_not_configured" }, 503);

    if (dailyChatLimit !== undefined) {
      const day = bangkokDate(now());
      const used = chatsByDay.get(day) ?? 0;
      if (used >= dailyChatLimit) return c.json({ error: "daily_limit_reached" }, 429);
      chatsByDay.clear();
      chatsByDay.set(day, used + 1);
    }

    const published = getPublished(db);
    const preview = body.preview === true;
    const snapshot = preview ? getDraft(db) : published.snapshot;
    const current = now();

    if (body.respect_hours) {
      const skipped = gateReason({ settings: snapshot.settings, now: current });
      if (skipped) return c.json({ skipped });
    }

    const customerId = body.customer_id ?? "demo-a";
    const result = await answerMessage({ text, image_url: body.image_url }, customerId, {
      snapshot,
      model,
      stock: stockProvider,
      orders,
      now: current,
      history: loadHistory(db, customerId),
      ...(retriever ? { retriever } : {}),
      ...(snapshot.settings.ordering?.enabled ? { ordering } : {}),
    });

    if (preview) return c.json({ preview: true, result });
    const saved = db
      .prepare("insert into replies(customer_id, text, has_image, version_id, result, created_at) values (?, ?, ?, ?, ?, ?)")
      .run(customerId, text, body.image_url ? 1 : 0, published.id, JSON.stringify(result), current.toISOString());
    return c.json({ id: Number(saved.lastInsertRowid), version_id: published.id, result });
  });

  // Testers can start a clean chat. Past replies stay in the queue and telemetry.
  app.post("/api/chat/reset", async (c) => {
    const body = (await c.req.json()) as { customer_id?: string };
    if (!body.customer_id) return c.json({ error: "customer_required" }, 400);
    db.prepare("insert into kv(key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(
      `history_reset:${body.customer_id}`,
      now().toISOString(),
    );
    cancelOpenDrafts(db, body.customer_id, now().toISOString());
    return c.json({ ok: true });
  });

  app.get("/api/queue", (c) => {
    const rows = db
      .prepare("select * from replies order by case status when 'pending' then 0 else 1 end, id desc limit 100")
      .all() as unknown as ReplyRow[];
    return c.json(rows.map(toReply));
  });

  app.post("/api/queue/:id/decision", async (c) => {
    const id = Number(c.req.param("id"));
    const body = (await c.req.json()) as { decision: "approve" | "edit" | "reject"; text?: string; reason?: string };
    const row = db.prepare("select * from replies where id = ?").get(id) as ReplyRow | undefined;
    if (!row) return c.json({ error: "not_found" }, 404);
    if (row.status !== "pending") return c.json({ error: "already_decided" }, 409);
    const result = JSON.parse(row.result) as BotResult;

    if (body.decision === "approve") {
      const changes = await recheckStock(result.stock_checks, stockProvider);
      if (changes.length > 0) {
        db.prepare("update replies set stock_flag = ? where id = ?").run(JSON.stringify(changes), id);
        return c.json({ error: "stock_changed", changes }, 409);
      }
    }
    if (body.decision === "edit" && !body.text?.trim()) return c.json({ error: "text_required" }, 400);
    if (!["approve", "edit", "reject"].includes(body.decision)) return c.json({ error: "invalid_decision" }, 400);

    const status = { approve: "approved", edit: "edited", reject: "rejected" }[body.decision];
    const finalText = body.decision === "approve" ? result.reply : body.decision === "edit" ? body.text!.trim() : null;
    // An order step counts only when its exact rendered text is sent. An edited summary or
    // payment message is sent as plain text and changes nothing.
    if (body.decision === "approve" && result.order && !applyOrderEffect(db, row.customer_id, result.order, now().toISOString())) {
      return c.json({ error: "order_state_changed" }, 409);
    }
    db.prepare("update replies set status = ?, final_text = ?, reason = ?, decided_at = ? where id = ?").run(
      status,
      finalText,
      body.reason ?? null,
      now().toISOString(),
      id,
    );
    return c.json({ ok: true, status });
  });

  app.get("/api/telemetry", (c) => {
    const rows = db.prepare("select * from replies").all() as unknown as ReplyRow[];
    const results = rows.map((row) => ({ row, result: JSON.parse(row.result) as BotResult }));
    const count = (values: string[]) =>
      Object.entries(
        values.reduce<Record<string, number>>((totals, value) => {
          totals[value] = (totals[value] ?? 0) + 1;
          return totals;
        }, {}),
      )
        .map(([name, total]) => ({ name, total }))
        .sort((a, b) => b.total - a.total);

    const total = results.length;
    const handoffs = results.filter(({ result }) => result.action === "handoff");
    const decided = rows.filter((row) => row.status !== "pending");
    const latencies = results.map(({ result }) => result.latency_ms).sort((a, b) => a - b);
    const costs = results.flatMap(({ result }) => (result.usage.cost === null ? [] : [result.usage.cost]));

    return c.json({
      total,
      handoff_rate: total ? handoffs.length / total : 0,
      by_topic: count(results.map(({ result }) => result.topic)),
      handoff_reasons: count(handoffs.flatMap(({ result }) => result.blocked_by.length > 0 ? result.blocked_by : ["model_chose_handoff"])),
      decisions: count(decided.map((row) => row.status)),
      approval_rate: decided.length ? decided.filter((row) => row.status === "approved").length / decided.length : null,
      safety_blocks: results.filter(({ result }) => result.blocked_by.length > 0).length,
      latency_ms: { p50: latencies[Math.floor(total * 0.5)] ?? null, p95: latencies[Math.floor(total * 0.95)] ?? null },
      tokens: results.reduce((sum, { result }) => sum + result.usage.prompt_tokens + result.usage.completion_tokens, 0),
      cost_usd: costs.length ? costs.reduce((sum, value) => sum + value, 0) : null,
      stock_reads: db.prepare("select count(*) as total, sum(statuses like '%unknown%' or statuses = 'error') as failed, avg(latency_ms) as avg_ms from stock_reads").get(),
      unanswered: handoffs.slice(-20).reverse().map(({ row, result }) => ({
        id: row.id,
        text: row.text,
        topic: result.topic,
        reasons: result.blocked_by,
      })),
    });
  });

  return app;
}
