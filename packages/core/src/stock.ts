import type { StockItem, StockProvider, StockStatus } from "./types.ts";

export interface CatalogAvailability {
  sku: string;
  in_stock?: boolean;
  web_sold_out?: boolean;
  on_hold?: boolean;
  count_pending?: boolean;
  restock_date?: string | null;
}

/** Mirrors the storefront: `in_stock` is the strict field, and `ready` alone is too optimistic. */
export function classifyAvailability(item: CatalogAvailability): StockStatus {
  if (item.on_hold) return "on_hold";
  if (item.web_sold_out) return "out_of_stock";
  if (item.count_pending) return "count_pending";
  if (item.in_stock === true) return "in_stock";
  if (item.in_stock === false) return "out_of_stock";
  return "unknown";
}

function unknownItems(skus: string[], now: Date): StockItem[] {
  return skus.map((sku) => ({ sku, status: "unknown", restock_date: null, checked_at: now.toISOString() }));
}

/** Reads the POC's editable data through a callback, so every call sees the latest row. */
export class SampleStockProvider implements StockProvider {
  private readonly read: (skus: string[]) => Promise<Omit<StockItem, "checked_at">[]>;

  constructor(read: (skus: string[]) => Promise<Omit<StockItem, "checked_at">[]>) {
    this.read = read;
  }

  async getStock(skus: string[]): Promise<StockItem[]> {
    const now = new Date();
    const rows = await this.read(skus);
    return skus.map((sku) => {
      const row = rows.find((candidate) => candidate.sku === sku);
      return row
        ? { ...row, checked_at: now.toISOString() }
        : { sku, status: "unknown", restock_date: null, checked_at: now.toISOString() };
    });
  }
}

/**
 * Disabled until Kin approves the read-only endpoint. Uses a limited key, never the
 * Supabase service-role key. Any failure reports `unknown`, which sends the chat to staff.
 */
export class TokitiStockProvider implements StockProvider {
  private readonly url: string;
  private readonly key: string;
  private readonly timeoutMs: number;

  constructor(url: string, key: string, timeoutMs = 3000) {
    this.url = url;
    this.key = key;
    this.timeoutMs = timeoutMs;
  }

  async getStock(skus: string[]): Promise<StockItem[]> {
    const now = new Date();
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json" },
        body: JSON.stringify({ skus }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return unknownItems(skus, now);
      const body = (await response.json()) as { items?: CatalogAvailability[] };
      const items = Array.isArray(body.items) ? body.items : [];
      return skus.map((sku) => {
        const item = items.find((candidate) => candidate.sku === sku);
        return {
          sku,
          status: item ? classifyAvailability(item) : "unknown",
          restock_date: item?.restock_date ?? null,
          checked_at: now.toISOString(),
        };
      });
    } catch {
      return unknownItems(skus, now);
    }
  }
}

export interface StockChange {
  sku: string;
  was: StockStatus;
  now: StockStatus;
}

/** Stock can change while a draft waits for staff, so approval reads it again. */
export async function recheckStock(checked: StockItem[], stock: StockProvider): Promise<StockChange[]> {
  if (checked.length === 0) return [];
  let latest: StockItem[];
  try {
    latest = await stock.getStock(checked.map((item) => item.sku));
  } catch {
    latest = unknownItems(checked.map((item) => item.sku), new Date());
  }
  return checked.flatMap((item) => {
    const current = latest.find((candidate) => candidate.sku === item.sku)?.status ?? "unknown";
    return current === item.status ? [] : [{ sku: item.sku, was: item.status, now: current }];
  });
}
