import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { BankDetails, OrderDraft, OrderEffect, OrderingProvider, OrderLine, OrderQuote, Snapshot } from "@tokiti/core";

/** Sample checkout settings. Every value is EXAMPLE data for the POC, never a real account. */
export interface SampleOrderingConfig {
  shipping_fee: number;
  bank: BankDetails | null;
}

export const ORDER_SCHEMA = `
create table if not exists order_drafts(
  id text primary key,
  customer_id text not null,
  state text not null,
  lines text not null,
  recipient text,
  quote text,
  summary_text text,
  updated_at text not null
);
`;

const OPEN = "state not in ('reviewed', 'cancelled')";

interface DraftRow {
  id: string;
  state: OrderDraft["state"];
  lines: string;
  recipient: string | null;
  quote: string | null;
  summary_text: string | null;
}

export function getOrderingConfig(db: DatabaseSync): SampleOrderingConfig {
  const row = db.prepare("select value from kv where key = 'ordering'").get() as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as SampleOrderingConfig) : { shipping_fee: 0, bank: null };
}

export function setOrderingConfig(db: DatabaseSync, config: SampleOrderingConfig): void {
  db.prepare("insert into kv(key, value) values ('ordering', ?) on conflict(key) do update set value = excluded.value").run(JSON.stringify(config));
}

/** Quotes from the published prices and the sample stock table, like the shop's real quote. */
export function sampleOrdering(db: DatabaseSync, snapshot: () => Snapshot): OrderingProvider {
  return {
    async quote(lines: OrderLine[], _postcode: string | null): Promise<OrderQuote> {
      const config = getOrderingConfig(db);
      const products = new Map(snapshot().products.map((product) => [product.sku, product]));
      const stock = new Map(
        (db.prepare("select sku, status from stock").all() as { sku: string; status: string }[]).map((row) => [row.sku, row.status]),
      );
      let status = "ready";
      const quoted = lines.map((line) => {
        const product = products.get(line.sku);
        const price = product?.online_price ?? null;
        if (!product || price === null) status = "price_unavailable";
        else if (stock.get(line.sku) !== "in_stock" && status === "ready") status = "out_of_stock";
        const name = product ? [product.name, product.color].filter(Boolean).join(" ") : line.sku;
        return { sku: line.sku, name, qty: line.qty, unit_price: price ?? 0, line_total: (price ?? 0) * line.qty };
      });
      const subtotal = quoted.reduce((sum, line) => sum + line.line_total, 0);
      const total = subtotal + config.shipping_fee;
      const signature = createHash("sha256")
        .update(JSON.stringify({ quoted, fee: config.shipping_fee, status }))
        .digest("hex");
      return { status, lines: quoted, subtotal, shipping_fee: config.shipping_fee, total, signature };
    },
    async current(customerId: string): Promise<OrderDraft | null> {
      const row = db
        .prepare(`select * from order_drafts where customer_id = ? and ${OPEN} order by updated_at desc limit 1`)
        .get(customerId) as DraftRow | undefined;
      if (!row) return null;
      const latest = db
        .prepare("select final_text from replies where customer_id = ? and final_text is not null order by decided_at desc, id desc limit 1")
        .get(customerId) as { final_text: string } | undefined;
      return {
        id: row.id,
        state: row.state,
        lines: JSON.parse(row.lines) as OrderLine[],
        recipient: row.recipient ? JSON.parse(row.recipient) : null,
        quote: row.quote ? JSON.parse(row.quote) : null,
        summary_text: row.summary_text,
        summary_is_latest: row.summary_text !== null && latest?.final_text === row.summary_text,
      };
    },
    async bank() {
      return getOrderingConfig(db).bank;
    },
  };
}

/** Stores an order step once its reply is actually sent. Each step only moves forward from its expected state. */
export function applyOrderEffect(db: DatabaseSync, customerId: string, effect: OrderEffect, at: string): boolean {
  if (effect.kind === "summary") {
    const open = db.prepare(`select id, state from order_drafts where customer_id = ? and ${OPEN}`).all(customerId) as { id: string; state: string }[];
    if (open.some((row) => !["collecting", "summary_sent"].includes(row.state))) return false;
    db.prepare(`update order_drafts set state = 'cancelled', updated_at = ? where customer_id = ? and ${OPEN} and id <> ?`).run(at, customerId, effect.draft_id ?? "");
    const id = effect.draft_id && open.some((row) => row.id === effect.draft_id) ? effect.draft_id : randomUUID();
    db.prepare(
      `insert into order_drafts(id, customer_id, state, lines, recipient, quote, summary_text, updated_at) values (?, ?, 'summary_sent', ?, ?, ?, ?, ?)
       on conflict(id) do update set state = 'summary_sent', lines = excluded.lines, recipient = excluded.recipient, quote = excluded.quote,
       summary_text = excluded.summary_text, updated_at = excluded.updated_at`,
    ).run(id, customerId, JSON.stringify(effect.lines), JSON.stringify(effect.recipient), JSON.stringify(effect.quote), effect.summary_text, at);
    return true;
  }
  const [from, to] = effect.kind === "confirm" ? ["summary_sent", "awaiting_slip"] : ["awaiting_slip", "slip_received"];
  const changed = db
    .prepare("update order_drafts set state = ?, updated_at = ? where id = ? and customer_id = ? and state = ?")
    .run(to, at, effect.draft_id, customerId, from);
  return Number(changed.changes) === 1;
}

export function cancelOpenDrafts(db: DatabaseSync, customerId: string, at: string): void {
  db.prepare(`update order_drafts set state = 'cancelled', updated_at = ? where customer_id = ? and ${OPEN}`).run(at, customerId);
}
