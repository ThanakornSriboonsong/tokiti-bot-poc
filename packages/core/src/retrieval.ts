import { isPromotionActive } from "./knowledge.ts";
import type { HistoryTurn, Snapshot } from "./types.ts";

/**
 * Retrieval picks the few approved sources that match a question, instead of sending all of them.
 * Search uses `text`, which may carry Thai labels and aliases; the model still sees the source JSON
 * from buildSources, so the safety checks compare numbers against exactly what the model saw.
 */
export interface Chunk {
  /** Same id as in buildSources, for example `product:TK101`. */
  id: string;
  kind: "product" | "promo" | "spec" | "faq";
  text: string;
  /** Names that count as a direct hit when the question contains them. */
  names: string[];
  /** Sources that belong with this one, such as a product's spec and its other colours. */
  links: string[];
}

export interface Hit {
  id: string;
  score: number;
  via: ("lexical" | "vector" | "link")[];
}

export interface SearchResult {
  hits: Hit[];
  /** Set when vector search failed and only word search ran. */
  error?: string;
}

export interface Retriever {
  readonly mode: "lexical" | "hybrid";
  search(chunks: Chunk[], query: string, k: number): Promise<SearchResult>;
}

const THAI_DIGITS = "๐๑๒๓๔๕๖๗๘๙";
const segmenter = new Intl.Segmenter("th", { granularity: "word" });

// Customers write colours in Thai while the catalogue names them in English.
// This is general vocabulary, not shop data, so it may live in code.
const SYNONYMS: Record<string, string[]> = {
  ขาว: ["white", "snow"],
  ชมพู: ["pink", "sakura"],
  เบจ: ["beige", "latte"],
  ครีม: ["beige", "cream"],
  น้ำตาล: ["brown", "latte"],
  ดำ: ["black"],
  เทา: ["grey", "gray"],
  white: ["ขาว"],
  pink: ["ชมพู"],
  beige: ["เบจ"],
};

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFC")
    .replace(/[๐-๙]/g, (digit) => String(THAI_DIGITS.indexOf(digit)));
}

// Function words and polite endings appear in every kind of question, so they only add noise.
// "ของ" is here too: in "มีของไหม" the product name, not "ของ", says what is being asked about.
const STOPWORDS = new Set(
  "มี ไหม มั้ย ป่าว เปล่า หรือ ยัง แล้ว ล่ะ ละ คะ ค่ะ ค่า ครับ คับ นะ จ้า จ้ะ ค่ะ ได้ ให้ ที่ จะ ก็ เป็น อยู่ ของ อะไร บ้าง หน่อย คุณ ฉัน เรา ผม หนู the a an is are do does".split(" "),
);

/** Thai has no spaces between words, so ICU's dictionary segmenter splits it. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const { segment, isWordLike } of segmenter.segment(normalize(text))) {
    if (!isWordLike || STOPWORDS.has(segment)) continue;
    tokens.push(segment);
    // The segmenter often keeps a colour joined to the word before it, as in "สีชมพู".
    for (const [word, synonyms] of SYNONYMS_LIST) {
      if (!segment.includes(word)) continue;
      if (word !== segment) tokens.push(word);
      tokens.push(...synonyms);
    }
  }
  return tokens;
}

const SYNONYMS_LIST = Object.entries(SYNONYMS);

const compact = (text: string) => normalize(text).replace(/\s+/g, "");

const splitAliases = (aliases: string | null | undefined) =>
  (aliases ?? "").split(",").map((alias) => alias.trim()).filter(Boolean);

const line = (label: string, value: string | number | null | undefined) => `${label}: ${value ?? "ร้านยังไม่ยืนยัน"}`;

/** One chunk per approved source, with the same ids and the same active-promotion rule. */
export function buildChunks(snapshot: Snapshot, now: Date): Chunk[] {
  const chunks: Chunk[] = [];
  const specs = new Map(snapshot.specs.map((spec) => [spec.id, spec]));

  for (const product of snapshot.products) {
    const spec = specs.get(product.spec_id);
    const aliases = splitAliases(spec?.aliases);
    const siblings = snapshot.products.filter((other) => other.spec_id === product.spec_id && other.sku !== product.sku);
    chunks.push({
      id: `product:${product.sku}`,
      kind: "product",
      text: [
        `สินค้า ${product.name} ${spec?.name ?? ""} ${aliases.join(" ")}`,
        line("สี", product.color),
        `รหัส ${product.sku}`,
        `ราคา ออนไลน์ ${product.online_price ?? ""} หน้างาน ${product.booth_price ?? ""} ปกติ ${product.regular_price ?? ""}`,
      ].join("\n"),
      names: [product.name, product.sku, ...(spec ? [spec.name] : []), ...aliases, ...(product.color ? [product.color] : [])],
      links: [`spec:${product.spec_id}`, ...siblings.map((other) => `product:${other.sku}`)],
    });
  }

  // Field labels below carry common Thai spellings ("โปรโมชั่น", "หมา") so word search can find
  // the field. They are search hints only; the model still reads the source JSON.
  const activePromotions = snapshot.promotions.filter((promotion) => isPromotionActive(promotion, now));
  for (const promotion of activePromotions) {
    chunks.push({
      id: `promo:${promotion.id}`,
      kind: "promo",
      text: `โปร โปรโมชัน โปรโมชั่น ราคา เซ็ต ส่วนลด ถูก คุ้ม ${promotion.title}\n${promotion.detail}`,
      names: [promotion.title, ...promotion.title.split(/\s+/).filter((word) => word.length >= 4)],
      // "มีโปรอะไรบ้าง" should see every promotion, not only the best-scoring one.
      links: activePromotions.filter((other) => other.id !== promotion.id).map((other) => `promo:${other.id}`),
    });
  }

  for (const spec of snapshot.specs) {
    const aliases = splitAliases(spec.aliases);
    chunks.push({
      id: `spec:${spec.id}`,
      kind: "spec",
      text: [
        `สเปก ข้อมูลสินค้า ${spec.name} ${aliases.join(" ")}`,
        line("ขนาด", spec.size),
        line("รับน้ำหนัก", spec.weight_limit),
        line("เหมาะกับสัตว์เลี้ยง แมว หมา สุนัข กระต่าย ใช้ได้ไหม", spec.pet_suitability),
        line("วัสดุ ทำจาก พลาสติก ผ้า", spec.material),
        line("การดูแล ซัก ล้าง", spec.care),
        line("จุดเด่น สี", spec.features),
      ].join("\n"),
      names: [spec.name, ...aliases],
      links: snapshot.products.filter((product) => product.spec_id === spec.id).map((product) => `product:${product.sku}`),
    });
  }

  for (const faq of snapshot.faqs) {
    chunks.push({
      id: `faq:${faq.id}`,
      kind: "faq",
      text: `${faq.topic}\n${faq.content}\n${faq.keywords ?? ""}`,
      names: [],
      links: [],
    });
  }
  return chunks;
}

/**
 * The latest message drives the search. The previous customer message is added at lower weight
 * so short follow-ups such as "แล้วมีของไหม" still find the product they refer to.
 */
export const QUERY_SEPARATOR = "\n⁣\n";

export function buildQuery(text: string, history: HistoryTurn[] = []): string {
  const previous = [...history].reverse().find((turn) => turn.role === "customer")?.text ?? "";
  return previous ? `${text}${QUERY_SEPARATOR}${previous}` : text;
}

const K1 = 1.2;
const B = 0.75;
const NAME_BOOST = 3;

interface LexicalIndex {
  docs: { chunk: Chunk; counts: Map<string, number>; length: number; names: string[] }[];
  df: Map<string, number>;
  avgLength: number;
}

const indexes = new WeakMap<Chunk[], LexicalIndex>();

function lexicalIndex(chunks: Chunk[]): LexicalIndex {
  const cached = indexes.get(chunks);
  if (cached) return cached;
  const df = new Map<string, number>();
  const docs = chunks.map((chunk) => {
    const tokens = tokenize(`${chunk.text}\n${chunk.names.join(" ")}`);
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    for (const token of counts.keys()) df.set(token, (df.get(token) ?? 0) + 1);
    return { chunk, counts, length: tokens.length, names: chunk.names.map(compact).filter((name) => name.length >= 2) };
  });
  const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length);
  const index = { docs, df, avgLength };
  indexes.set(chunks, index);
  return index;
}

/** BM25 over Thai word segments, plus a boost when the question names the product directly. */
export function lexicalScores(chunks: Chunk[], query: string): Map<string, number> {
  const { docs, df, avgLength } = lexicalIndex(chunks);
  const [latest = "", previous = ""] = query.split(QUERY_SEPARATOR);
  const latestTokens = new Set(tokenize(latest));
  const weighted: [string, number][] = [
    ...[...latestTokens].map((token): [string, number] => [token, 1]),
    ...[...new Set(tokenize(previous))].filter((token) => !latestTokens.has(token)).map((token): [string, number] => [token, 0.5]),
  ];
  const latestCompact = compact(latest);
  const restCompact = compact(previous);
  const scores = new Map<string, number>();

  for (const doc of docs) {
    let score = 0;
    for (const [token, weight] of weighted) {
      const tf = doc.counts.get(token);
      if (!tf) continue;
      const n = df.get(token) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += weight * idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / avgLength)));
    }
    if (doc.names.some((name) => latestCompact.includes(name))) score += NAME_BOOST;
    else if (doc.names.some((name) => restCompact.includes(name))) score += NAME_BOOST / 2;
    if (score > 0) scores.set(doc.chunk.id, score);
  }
  return scores;
}

function ranked(scores: Map<string, number>): string[] {
  return [...scores].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** Adds each hit's linked sources after the ranked ones, so a price answer also sees the spec. */
export function expandLinks(chunks: Chunk[], hits: Hit[], limit: number): Hit[] {
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const out = [...hits];
  const seen = new Set(hits.map((hit) => hit.id));
  for (const hit of hits) {
    for (const link of byId.get(hit.id)?.links ?? []) {
      if (out.length >= limit) return out;
      if (seen.has(link) || !byId.has(link)) continue;
      seen.add(link);
      out.push({ id: link, score: 0, via: ["link"] });
    }
  }
  return out;
}

/** Word-search hits scoring below this share of the best hit are dropped as noise. */
const MIN_RELATIVE_SCORE = 0.3;

export class LexicalRetriever implements Retriever {
  readonly mode = "lexical" as const;

  async search(chunks: Chunk[], query: string, k: number): Promise<SearchResult> {
    const scores = lexicalScores(chunks, query);
    const order = ranked(scores);
    const floor = (scores.get(order[0] ?? "") ?? 0) * MIN_RELATIVE_SCORE;
    const hits = order
      .filter((id) => scores.get(id)! >= floor)
      .slice(0, k)
      .map((id) => ({ id, score: scores.get(id)!, via: ["lexical"] as Hit["via"] }));
    return { hits: expandLinks(chunks, hits, k * 2) };
  }
}

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

export const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";

export class OpenRouterEmbedder implements Embedder {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(config: { apiKey: string; model: string; timeoutMs?: number }) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey.trim()}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts, provider: { data_collection: "deny" } }),
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((cause: Error) => {
      // Only the error's name, since Node can quote the auth header in its message.
      throw new Error(`embedding_request_failed: ${cause.name}`);
    });
    const body = (await response.json().catch(() => ({}))) as {
      data?: { embedding?: number[]; index?: number }[];
      error?: { message?: string };
    };
    if (!response.ok || body.error || !body.data) throw new Error(`embedding_error: ${body.error?.message ?? response.status}`);
    const vectors: number[][] = [];
    body.data.forEach((item, position) => {
      if (!Array.isArray(item.embedding)) throw new Error("embedding_error: not_a_float_vector");
      vectors[item.index ?? position] = item.embedding;
    });
    if (vectors.length !== texts.length) throw new Error("embedding_error: wrong_count");
    return vectors;
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const RRF_K = 60;
/** Vector matches below this are noise for a small catalogue; tune with the retrieval eval. */
const MIN_SIMILARITY = 0.2;

/**
 * Word search and vector search ranked together with reciprocal rank fusion.
 * Chunk vectors are cached by text, so only new or edited sources are embedded again.
 * If embedding fails, the search still runs on words alone and reports the error.
 */
export class HybridRetriever implements Retriever {
  readonly mode = "hybrid" as const;
  private readonly embedder: Embedder;
  private readonly cache = new Map<string, number[]>();
  private readonly minSimilarity: number;

  constructor(embedder: Embedder, options: { minSimilarity?: number } = {}) {
    this.embedder = embedder;
    this.minSimilarity = options.minSimilarity ?? MIN_SIMILARITY;
  }

  private async vectors(texts: string[]): Promise<number[][]> {
    const missing = [...new Set(texts.filter((text) => !this.cache.has(text)))];
    if (missing.length > 0) {
      const fresh = await this.embedder.embed(missing);
      missing.forEach((text, index) => this.cache.set(text, fresh[index]!));
    }
    return texts.map((text) => this.cache.get(text)!);
  }

  async search(chunks: Chunk[], query: string, k: number): Promise<SearchResult> {
    const lexical = ranked(lexicalScores(chunks, query));
    let vector: string[] = [];
    let error: string | undefined;
    try {
      const [queryVector, ...chunkVectors] = await this.vectors([query, ...chunks.map((chunk) => chunk.text)]);
      const similarity = new Map<string, number>();
      chunks.forEach((chunk, index) => {
        const value = cosine(queryVector!, chunkVectors[index]!);
        if (value >= this.minSimilarity) similarity.set(chunk.id, value);
      });
      vector = ranked(similarity);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }

    const fused = new Map<string, Hit>();
    const add = (ids: string[], via: "lexical" | "vector") =>
      ids.forEach((id, rank) => {
        const hit = fused.get(id) ?? { id, score: 0, via: [] };
        hit.score += 1 / (RRF_K + rank + 1);
        hit.via.push(via);
        fused.set(id, hit);
      });
    add(lexical, "lexical");
    add(vector, "vector");
    const hits = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, k);
    return { hits: expandLinks(chunks, hits, k * 2), ...(error ? { error } : {}) };
  }
}
