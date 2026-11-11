export const TOPICS = [
  "price_promo",
  "delivery",
  "size_weight",
  "stock_restock",
  "order_tracking",
  "image",
  "review",
  "risky",
  "other",
] as const;
export type Topic = (typeof TOPICS)[number];

export type Action = "answer" | "ask_followup" | "handoff";

export interface Product {
  sku: string;
  name: string;
  color: string | null;
  regular_price: number | null;
  online_price: number | null;
  booth_price: number | null;
  spec_id: string;
  needs_review?: boolean;
}

export interface Promotion {
  id: string;
  title: string;
  detail: string;
  channel: "online" | "booth" | "all";
  starts_at: string | null;
  ends_at: string | null;
  needs_review?: boolean;
}

export interface Spec {
  id: string;
  name: string;
  /** Other names customers use, comma-separated, for example "ตะกร้า, ตะกร้าแมว". */
  aliases?: string | null;
  size: string | null;
  weight_limit: string | null;
  pet_suitability: string | null;
  material: string | null;
  care: string | null;
  features: string | null;
  needs_review?: boolean;
}

export interface Faq {
  id: string;
  topic: string;
  content: string;
  /** Words customers use for this topic. Search only: never shown to the model or quoted. */
  keywords?: string | null;
  needs_review?: boolean;
}

export interface Settings {
  enabled: boolean;
  bot_hours: { start: string; end: string };
  topics: Topic[];
  min_confidence: number;
  /** Off or missing: every approved source goes in the prompt. On: only the top matches. */
  retrieval?: { enabled: boolean; top_k: number };
}

export interface RetrievalReport {
  mode: "lexical" | "hybrid";
  query: string;
  /** Ids the search returned, best first, including linked ones. */
  hits: { id: string; score: number; via: string[] }[];
  /** Times the model asked for more with search_knowledge. */
  searches: number;
  /** True when search had nothing to use or found nothing, or failed, so every source was sent. */
  sent_all: boolean;
  error?: string;
}

export interface Snapshot {
  products: Product[];
  promotions: Promotion[];
  specs: Spec[];
  faqs: Faq[];
  settings: Settings;
}

export type StockStatus = "in_stock" | "out_of_stock" | "on_hold" | "count_pending" | "unknown";

export interface StockItem {
  sku: string;
  status: StockStatus;
  restock_date: string | null;
  checked_at: string;
}

export interface StockProvider {
  getStock(skus: string[]): Promise<StockItem[]>;
}

export interface Order {
  code: string;
  state: string;
  carrier: string | null;
  tracking: string | null;
}

/** The app supplies customerId. The model can never choose it. */
export interface OrderProvider {
  listForCustomer(customerId: string): Promise<Order[]>;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  cost: number | null;
}

export type Part =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | Part[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ModelRequest {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  schema: Record<string, unknown>;
}

export interface ModelResponse {
  content: string | null;
  tool_calls: ToolCall[];
  usage: Usage;
  model: string;
}

export interface ModelProvider {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export interface ModelAnswer {
  action: Action;
  topic: Topic;
  reply_th: string;
  source_ids: string[];
  confidence: number;
}

export interface CustomerMessage {
  text: string;
  image_url?: string;
}

/** An earlier chat message. `shop` means a reply the customer actually received. */
export interface HistoryTurn {
  role: "customer" | "shop";
  text: string;
  at: string;
}

export interface BotResult {
  action: Action;
  topic: Topic;
  reply: string;
  model_reply: string | null;
  source_ids: string[];
  confidence: number;
  blocked_by: string[];
  stock_checks: StockItem[];
  tool_calls: string[];
  usage: Usage;
  model: string | null;
  latency_ms: number;
  history_count: number;
  retrieval?: RetrievalReport;
  error?: string;
}
