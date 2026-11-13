import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { Order, Snapshot, StockStatus } from "@tokiti/core";
import { ORDER_SCHEMA, setOrderingConfig, type SampleOrderingConfig } from "./ordering.ts";

export const SEED_PATH = fileURLToPath(new URL("../../../data/seed/sample.json", import.meta.url));
export const DB_PATH = fileURLToPath(new URL("../../../data/poc.db", import.meta.url));

interface Seed extends Snapshot {
  stock: { sku: string; status: StockStatus; restock_date: string | null }[];
  orders: (Order & { customer_id: string })[];
  ordering?: SampleOrderingConfig;
}

const SCHEMA = `
create table if not exists kv(key text primary key, value text not null);
create table if not exists versions(
  id integer primary key autoincrement,
  snapshot text not null,
  note text,
  created_at text not null
);
create table if not exists stock(
  sku text primary key,
  status text not null,
  restock_date text
);
create table if not exists orders(
  customer_id text not null,
  code text primary key,
  state text not null,
  carrier text,
  tracking text
);
create table if not exists replies(
  id integer primary key autoincrement,
  customer_id text not null,
  text text not null,
  has_image integer not null default 0,
  version_id integer,
  result text not null,
  status text not null default 'pending',
  final_text text,
  reason text,
  stock_flag text,
  created_at text not null,
  decided_at text
);
create table if not exists stock_reads(
  id integer primary key autoincrement,
  skus text not null,
  statuses text not null,
  latency_ms integer not null,
  created_at text not null
);
`;

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  db.exec(ORDER_SCHEMA);
  return db;
}

export function seedDb(db: DatabaseSync, seed: Seed = JSON.parse(readFileSync(SEED_PATH, "utf8"))): void {
  const snapshot: Snapshot = {
    products: seed.products,
    promotions: seed.promotions,
    specs: seed.specs,
    faqs: seed.faqs,
    settings: seed.settings,
  };
  db.exec("delete from kv; delete from versions; delete from stock; delete from orders; delete from replies; delete from stock_reads; delete from order_drafts;");
  setOrderingConfig(db, seed.ordering ?? { shipping_fee: 0, bank: null });
  setDraft(db, snapshot);
  publish(db, "ข้อมูลตัวอย่าง");
  const insertStock = db.prepare("insert into stock(sku, status, restock_date) values (?, ?, ?)");
  for (const row of seed.stock) insertStock.run(row.sku, row.status, row.restock_date);
  const insertOrder = db.prepare("insert into orders(customer_id, code, state, carrier, tracking) values (?, ?, ?, ?, ?)");
  for (const row of seed.orders) insertOrder.run(row.customer_id, row.code, row.state, row.carrier, row.tracking);
}

function getValue(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("select value from kv where key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setValue(db: DatabaseSync, key: string, value: string): void {
  db.prepare("insert into kv(key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(key, value);
}

export function getDraft(db: DatabaseSync): Snapshot {
  const value = getValue(db, "draft");
  if (!value) throw new Error("not_seeded");
  return JSON.parse(value) as Snapshot;
}

export function setDraft(db: DatabaseSync, snapshot: Snapshot): void {
  setValue(db, "draft", JSON.stringify(snapshot));
}

export function publish(db: DatabaseSync, note: string | null): number {
  const result = db
    .prepare("insert into versions(snapshot, note, created_at) values (?, ?, ?)")
    .run(JSON.stringify(getDraft(db)), note, new Date().toISOString());
  const id = Number(result.lastInsertRowid);
  setValue(db, "published_version", String(id));
  return id;
}

export function getPublished(db: DatabaseSync): { id: number; snapshot: Snapshot } {
  const id = Number(getValue(db, "published_version"));
  const row = db.prepare("select snapshot from versions where id = ?").get(id) as { snapshot: string } | undefined;
  if (!row) throw new Error("not_seeded");
  return { id, snapshot: JSON.parse(row.snapshot) as Snapshot };
}

/** The live version moves back, and the draft follows so the next publish starts from it. */
export function rollback(db: DatabaseSync, id: number): boolean {
  const row = db.prepare("select snapshot from versions where id = ?").get(id) as { snapshot: string } | undefined;
  if (!row) return false;
  setValue(db, "published_version", String(id));
  setValue(db, "draft", row.snapshot);
  return true;
}
