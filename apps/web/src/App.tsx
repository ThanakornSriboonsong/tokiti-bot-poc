import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  ApiError,
  REASON_LABELS,
  STOCK_LABELS,
  TOPIC_LABELS,
  api,
  type BotResult,
  type QueueItem,
  type Snapshot,
  type StockRow,
  type StockStatus,
  type Telemetry,
  type Versions,
} from "./api.ts";

const PAGES = [
  ["chat", "ทดสอบแชท"],
  ["queue", "คิวตรวจคำตอบ"],
  ["promos", "โปรโมชั่นและราคา"],
  ["specs", "ข้อมูลสินค้า"],
  ["faqs", "คำถามและนโยบาย"],
  ["stock", "สต๊อกตัวอย่าง"],
  ["settings", "ตั้งค่าบอท"],
  ["telemetry", "สถิติ"],
] as const;
type Page = (typeof PAGES)[number][0];

function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    load().then(setData, (cause: Error) => setError(cause.message));
  }, [load]);
  useEffect(reload, [reload]);
  return { data, setData, error, reload };
}

function Loading({ error }: { error: string | null }) {
  return <p className={error ? "error" : "muted"}>{error ? `โหลดไม่สำเร็จ: ${error}` : "กำลังโหลด..."}</p>;
}

export function App() {
  const [page, setPage] = useState<Page>("chat");
  return (
    <div className="layout">
      <nav>
        <h1>TOKITI Bot</h1>
        <p className="muted small">POC ข้อมูลตัวอย่าง ไม่ส่งถึงลูกค้า</p>
        {PAGES.map(([id, label]) => (
          <button key={id} className={page === id ? "active" : ""} onClick={() => setPage(id)}>
            {label}
          </button>
        ))}
      </nav>
      <main>
        {page === "chat" && <ChatPage />}
        {page === "queue" && <QueuePage />}
        {page === "promos" && <DraftPage kind="promos" />}
        {page === "specs" && <DraftPage kind="specs" />}
        {page === "faqs" && <DraftPage kind="faqs" />}
        {page === "stock" && <StockPage />}
        {page === "settings" && <DraftPage kind="settings" />}
        {page === "telemetry" && <TelemetryPage />}
      </main>
    </div>
  );
}

function ResultCard({ result }: { result: BotResult }) {
  return (
    <div className={`card ${result.action === "handoff" ? "warn" : ""}`}>
      <div className="row">
        <span className="tag">{result.action === "handoff" ? "ส่งต่อทีมงาน" : result.action === "ask_followup" ? "ถามกลับ" : "ตอบ"}</span>
        <span className="tag">{TOPIC_LABELS[result.topic]}</span>
        <span className="muted small">
          ความมั่นใจ {Math.round(result.confidence * 100)}% · {result.latency_ms} ms
          {result.history_count > 0 ? ` · ใช้ประวัติแชท ${result.history_count} ข้อความ` : ""}
        </span>
      </div>
      <p className="reply">{result.reply}</p>
      {result.blocked_by.length > 0 && (
        <p className="small error">ถูกกันไว้: {result.blocked_by.map((reason) => REASON_LABELS[reason] ?? reason).join(", ")}</p>
      )}
      {result.error && <p className="small error">รายละเอียด: {result.error}</p>}
      {result.model_reply && result.model_reply !== result.reply && <p className="small muted">ร่างจากโมเดล: {result.model_reply}</p>}
      {result.source_ids.length > 0 && <p className="small muted">แหล่งข้อมูล: {result.source_ids.join(", ")}</p>}
      {result.retrieval && (
        <p className="small muted">
          ค้นข้อมูล ({result.retrieval.mode === "hybrid" ? "คำ + ความหมาย" : "คำ"}):{" "}
          {result.retrieval.sent_all
            ? "ไม่มีคำให้ค้น จึงส่งข้อมูลทั้งหมด"
            : result.retrieval.hits.length > 0
              ? result.retrieval.hits.map((hit) => (hit.via.includes("link") ? `${hit.id} (ที่เกี่ยวข้อง)` : hit.id)).join(", ")
              : "ไม่พบข้อมูลที่ตรง"}
          {result.retrieval.searches > 0 ? ` · โมเดลค้นเพิ่ม ${result.retrieval.searches} ครั้ง` : ""}
          {result.retrieval.error ? ` · ค้นแบบความหมายไม่สำเร็จ: ${result.retrieval.error}` : ""}
        </p>
      )}
      {result.stock_checks.length > 0 && (
        <p className="small muted">
          สต๊อกล่าสุด: {result.stock_checks.map((item) => `${item.sku} ${STOCK_LABELS[item.status]}`).join(", ")}
        </p>
      )}
    </div>
  );
}

function ChatPage() {
  const [text, setText] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [customer, setCustomer] = useState("demo-a");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<{ text: string; result: BotResult }[]>([]);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = await api<{ result: BotResult }>("/chat", "POST", {
        text,
        customer_id: customer,
        preview,
        ...(image ? { image_url: image } : {}),
      });
      setHistory((items) => [{ text: text || "(ส่งรูป)", result: body.result }, ...items]);
      setText("");
      setImage(null);
    } catch (cause) {
      const message = (cause as Error).message;
      const messages: Record<string, string> = {
        model_not_configured: "ยังไม่ได้ตั้ง OPENROUTER_API_KEY และ OPENROUTER_MODEL",
        daily_limit_reached: "ใช้ครบโควตาทดสอบของวันนี้แล้ว ลองใหม่พรุ่งนี้",
        image_too_large: "รูปใหญ่เกินไป",
      };
      setError(messages[message] ?? message);
    } finally {
      setBusy(false);
    }
  };

  const resetChat = async () => {
    setError(null);
    try {
      await api("/chat/reset", "POST", { customer_id: customer });
      setHistory([]);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const pickImage = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setImage(String(reader.result));
    reader.readAsDataURL(file);
  };

  return (
    <section>
      <h2>ทดสอบแชท</h2>
      <textarea rows={3} value={text} placeholder="พิมพ์คำถามแบบลูกค้า" onChange={(event) => setText(event.target.value)} />
      <div className="row">
        <input type="file" accept="image/*" aria-label="แนบรูป" onChange={(event) => pickImage(event.target.files?.[0])} />
        <label>
          ลูกค้า{" "}
          <select value={customer} onChange={(event) => setCustomer(event.target.value)}>
            <option value="demo-a">demo-a</option>
            <option value="demo-b">demo-b</option>
            <option value="demo-none">ไม่มีออเดอร์</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={preview} onChange={(event) => setPreview(event.target.checked)} /> ใช้ฉบับร่าง
        </label>
        <button className="primary" disabled={busy || (!text.trim() && !image)} onClick={send}>
          {busy ? "กำลังถาม..." : "ส่ง"}
        </button>
        <button onClick={resetChat}>เริ่มแชทใหม่</button>
      </div>
      {image && <img className="thumb" src={image} alt="รูปที่แนบ" />}
      {error && <p className="error">{error}</p>}
      {history.map((item, index) => (
        <div key={history.length - index}>
          <p className="customer">{item.text}</p>
          <ResultCard result={item.result} />
        </div>
      ))}
    </section>
  );
}

function QueuePage() {
  const load = useCallback(() => api<QueueItem[]>("/queue"), []);
  const { data, error, reload } = useLoad(load);
  if (!data) return <Loading error={error} />;
  return (
    <section>
      <h2>คิวตรวจคำตอบ</h2>
      {data.length === 0 && <p className="muted">ยังไม่มีคำตอบในคิว</p>}
      {data.map((item) => <QueueCard key={item.id} item={item} reload={reload} />)}
    </section>
  );
}

// Blocks that don't mean the draft is wrong. A draft blocked for anything else, such as a price
// missing from the data, is never offered as the starting text.
const SOFT_BLOCKS = ["low_confidence", "no_source"];

function QueueCard({ item, reload }: { item: QueueItem; reload: () => void }) {
  const { result } = item;
  const offerDraft =
    result.action === "handoff" &&
    result.model_reply !== null &&
    result.model_reply.trim() !== "" &&
    result.blocked_by.length > 0 &&
    result.blocked_by.every((reason) => SOFT_BLOCKS.includes(reason));
  const [text, setText] = useState(offerDraft ? result.model_reply! : result.reply);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const decide = async (decision: "approve" | "edit" | "reject") => {
    setNotice(null);
    try {
      await api(`/queue/${item.id}/decision`, "POST", { decision, text, reason });
      reload();
    } catch (cause) {
      if (cause instanceof ApiError && cause.message === "stock_changed") {
        setNotice("สต๊อกเปลี่ยนหลังร่างคำตอบ กรุณาแก้ข้อความก่อนบันทึก");
      } else {
        setNotice((cause as Error).message);
      }
    }
  };

  return (
    <article className="queue">
      <p className="customer">{item.text}{item.has_image ? " (มีรูป)" : ""}</p>
      <ResultCard result={item.result} />
      {item.status === "pending" ? (
        <>
          {item.stock_flag && <p className="error small">สต๊อกเปลี่ยน: {item.stock_flag.map((change) => `${change.sku} ${change.was} → ${change.now}`).join(", ")}</p>}
          {offerDraft && <p className="small muted">ข้อความด้านล่างมาจากร่างของโมเดล ตรวจให้ถูกต้องก่อนกดบันทึกที่แก้</p>}
          <textarea rows={2} aria-label="ข้อความที่จะส่ง" value={text} onChange={(event) => setText(event.target.value)} />
          <input aria-label="เหตุผล" placeholder="เหตุผล (ถ้าแก้หรือปฏิเสธ)" value={reason} onChange={(event) => setReason(event.target.value)} />
          <div className="row">
            <button className="primary" disabled={text !== item.result.reply} onClick={() => decide("approve")}>อนุมัติ</button>
            <button disabled={text === item.result.reply} onClick={() => decide("edit")}>บันทึกที่แก้</button>
            <button onClick={() => decide("reject")}>ปฏิเสธ</button>
          </div>
          {notice && <p className="error small">{notice}</p>}
        </>
      ) : (
        <p className="small muted">สถานะ: {item.status}{item.final_text ? ` · ${item.final_text}` : ""}{item.reason ? ` · ${item.reason}` : ""}</p>
      )}
    </article>
  );
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string | number | null; onChange: (value: string) => void; type?: string }) {
  return (
    <label className="field">
      {label}
      <input type={type} value={value ?? ""} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

const nullable = (value: string) => (value.trim() === "" ? null : value);
const numeric = (value: string) => (value.trim() === "" ? null : Number(value));

function DraftPage({ kind }: { kind: "promos" | "specs" | "faqs" | "settings" }) {
  const load = useCallback(() => api<Snapshot>("/draft"), []);
  const { data: draft, setData, error } = useLoad(load);
  const versionsLoad = useCallback(() => api<Versions>("/versions"), []);
  const versions = useLoad(versionsLoad);
  const [notice, setNotice] = useState<string | null>(null);

  if (!draft) return <Loading error={error} />;

  const update = (next: Snapshot) => {
    setData(next);
    setNotice("มีการแก้ไขที่ยังไม่บันทึก");
  };
  const save = async () => {
    await api("/draft", "PUT", draft);
    setNotice("บันทึกฉบับร่างแล้ว ทดสอบได้ที่หน้าทดสอบแชท");
  };
  const publish = async () => {
    await api("/draft", "PUT", draft);
    const { id } = await api<{ id: number }>("/publish", "POST", { note: kind });
    setNotice(`เผยแพร่เวอร์ชัน ${id} แล้ว บอทใช้ตั้งแต่ข้อความถัดไป`);
    versions.reload();
  };
  const rollback = async (id: number) => {
    await api(`/rollback/${id}`, "POST");
    setData(await api<Snapshot>("/draft"));
    setNotice(`ย้อนกลับเป็นเวอร์ชัน ${id} แล้ว`);
    versions.reload();
  };

  const body: Record<typeof kind, ReactNode> = {
    promos: <PromoEditor draft={draft} update={update} />,
    specs: <SpecEditor draft={draft} update={update} />,
    faqs: <FaqEditor draft={draft} update={update} />,
    settings: <SettingsEditor draft={draft} update={update} />,
  };

  return (
    <section>
      <div className="row between">
        <h2>{PAGES.find(([id]) => id === kind)?.[1]}</h2>
        <div className="row">
          <button onClick={save}>บันทึกร่าง</button>
          <button className="primary" onClick={publish}>เผยแพร่</button>
        </div>
      </div>
      {notice && <p className="notice">{notice}</p>}
      {body[kind]}
      <h3>เวอร์ชันที่เผยแพร่</h3>
      {versions.data?.versions.slice(0, 8).map((version) => (
        <div className="row" key={version.id}>
          <span>#{version.id} {version.note ?? ""}</span>
          <span className="muted small">{new Date(version.created_at).toLocaleString("th-TH")}</span>
          {version.id === versions.data?.current ? <span className="tag">ใช้งานอยู่</span> : <button onClick={() => rollback(version.id)}>ย้อนกลับ</button>}
        </div>
      ))}
    </section>
  );
}

interface EditorProps {
  draft: Snapshot;
  update: (next: Snapshot) => void;
}

function PromoEditor({ draft, update }: EditorProps) {
  const setPromo = (index: number, patch: Partial<Snapshot["promotions"][number]>) =>
    update({ ...draft, promotions: draft.promotions.map((promo, i) => (i === index ? { ...promo, ...patch } : promo)) });
  const setProduct = (index: number, patch: Partial<Snapshot["products"][number]>) =>
    update({ ...draft, products: draft.products.map((product, i) => (i === index ? { ...product, ...patch } : product)) });
  return (
    <>
      <div className="row between">
        <h3>โปรโมชั่น</h3>
        <button onClick={() => update({ ...draft, promotions: [...draft.promotions, { id: `promo-${crypto.randomUUID().slice(0, 8)}`, title: "", detail: "", channel: "online", starts_at: null, ends_at: null }] })}>
          เพิ่มโปรโมชั่น
        </button>
      </div>
      {draft.promotions.map((promo, index) => (
        <div className="card" key={promo.id}>
          <Field label="ชื่อ" value={promo.title} onChange={(title) => setPromo(index, { title })} />
          <label className="field">
            รายละเอียด
            <textarea rows={2} value={promo.detail} onChange={(event) => setPromo(index, { detail: event.target.value })} />
          </label>
          <div className="row">
            <Field label="เริ่ม" type="date" value={promo.starts_at} onChange={(value) => setPromo(index, { starts_at: nullable(value) })} />
            <Field label="สิ้นสุด" type="date" value={promo.ends_at} onChange={(value) => setPromo(index, { ends_at: nullable(value) })} />
            <label className="field">
              ช่องทาง
              <select value={promo.channel} onChange={(event) => setPromo(index, { channel: event.target.value as typeof promo.channel })}>
                <option value="online">ออนไลน์</option>
                <option value="booth">หน้างาน</option>
                <option value="all">ทุกช่องทาง</option>
              </select>
            </label>
            <button onClick={() => update({ ...draft, promotions: draft.promotions.filter((_, i) => i !== index) })}>ลบ</button>
          </div>
        </div>
      ))}
      <h3>ราคาสินค้า (ตัวอย่าง)</h3>
      <table>
        <thead><tr><th>SKU</th><th>สินค้า</th><th>ปกติ</th><th>ออนไลน์</th><th>หน้างาน</th></tr></thead>
        <tbody>
          {draft.products.map((product, index) => (
            <tr key={product.sku}>
              <td>{product.sku}</td>
              <td>{product.name} {product.color ?? ""}</td>
              {(["regular_price", "online_price", "booth_price"] as const).map((key) => (
                <td key={key}>
                  <input aria-label={`${product.sku} ${key}`} type="number" value={product[key] ?? ""} onChange={(event) => setProduct(index, { [key]: numeric(event.target.value) })} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function SpecEditor({ draft, update }: EditorProps) {
  const fields = [
    ["aliases", "ชื่ออื่นที่ลูกค้าเรียก (คั่นด้วย ,)"],
    ["size", "ขนาด"],
    ["weight_limit", "รับน้ำหนัก"],
    ["pet_suitability", "สัตว์เลี้ยงที่เหมาะ"],
    ["material", "วัสดุ"],
    ["care", "การดูแล"],
    ["features", "จุดเด่น"],
  ] as const;
  return (
    <>
      <p className="muted">ช่องที่ว่างอยู่ บอทจะส่งต่อทีมงานแทนการเดา</p>
      {draft.specs.map((spec, index) => (
        <div className="card" key={spec.id}>
          <h3>{spec.name}</h3>
          {fields.map(([key, label]) => (
            <Field
              key={key}
              label={label}
              value={spec[key] ?? null}
              onChange={(value) => update({ ...draft, specs: draft.specs.map((item, i) => (i === index ? { ...item, [key]: nullable(value) } : item)) })}
            />
          ))}
        </div>
      ))}
    </>
  );
}

function FaqEditor({ draft, update }: EditorProps) {
  const setFaq = (index: number, patch: Partial<Snapshot["faqs"][number]>) =>
    update({ ...draft, faqs: draft.faqs.map((faq, i) => (i === index ? { ...faq, ...patch } : faq)) });
  return (
    <>
      <button onClick={() => update({ ...draft, faqs: [...draft.faqs, { id: `faq-${crypto.randomUUID().slice(0, 8)}`, topic: "", content: "" }] })}>เพิ่มหัวข้อ</button>
      {draft.faqs.map((faq, index) => (
        <div className="card" key={faq.id}>
          <Field label="หัวข้อ" value={faq.topic} onChange={(topic) => setFaq(index, { topic })} />
          <label className="field">
            เนื้อหา
            <textarea rows={3} value={faq.content} onChange={(event) => setFaq(index, { content: event.target.value })} />
          </label>
          <Field
            label="คำค้นเพิ่ม (คำที่ลูกค้ามักพิมพ์ ใช้ค้นหาเท่านั้น บอทไม่นำไปตอบ)"
            value={faq.keywords ?? ""}
            onChange={(keywords) => setFaq(index, { keywords })}
          />
          <button onClick={() => update({ ...draft, faqs: draft.faqs.filter((_, i) => i !== index) })}>ลบ</button>
        </div>
      ))}
    </>
  );
}

function SettingsEditor({ draft, update }: EditorProps) {
  const { settings } = draft;
  const setSettings = (patch: Partial<typeof settings>) => update({ ...draft, settings: { ...settings, ...patch } });
  const toggleTopic = (topic: (typeof settings.topics)[number]) =>
    setSettings({ topics: settings.topics.includes(topic) ? settings.topics.filter((item) => item !== topic) : [...settings.topics, topic] });
  return (
    <div className="card">
      <label><input type="checkbox" checked={settings.enabled} onChange={(event) => setSettings({ enabled: event.target.checked })} /> เปิดบอท</label>
      <div className="row">
        <Field label="เริ่มตอบ" type="time" value={settings.bot_hours.start} onChange={(start) => setSettings({ bot_hours: { ...settings.bot_hours, start } })} />
        <Field label="หยุดตอบ" type="time" value={settings.bot_hours.end} onChange={(end) => setSettings({ bot_hours: { ...settings.bot_hours, end } })} />
        <Field label="ความมั่นใจขั้นต่ำ" type="number" value={settings.min_confidence} onChange={(value) => setSettings({ min_confidence: Number(value) })} />
      </div>
      <h3>การค้นข้อมูล (RAG)</h3>
      <label className="block">
        <input
          type="checkbox"
          checked={settings.retrieval?.enabled ?? false}
          onChange={(event) => setSettings({ retrieval: { top_k: settings.retrieval?.top_k ?? 6, enabled: event.target.checked } })}
        />{" "}
        ส่งให้โมเดลเฉพาะข้อมูลที่ตรงกับคำถาม (ปิด = ส่งข้อมูลทั้งหมดทุกครั้ง)
      </label>
      {settings.retrieval?.enabled && (
        <Field
          label="จำนวนข้อมูลที่ค้นได้สูงสุด"
          type="number"
          value={settings.retrieval.top_k}
          onChange={(value) => setSettings({ retrieval: { enabled: true, top_k: Math.max(1, Number(value) || 1) } })}
        />
      )}
      <h3>หัวข้อที่เปิดให้ตอบ</h3>
      {(["price_promo", "delivery", "size_weight", "stock_restock", "order_tracking", "image", "review"] as const).map((topic) => (
        <label className="block" key={topic}>
          <input type="checkbox" checked={settings.topics.includes(topic)} onChange={() => toggleTopic(topic)} /> {TOPIC_LABELS[topic]}
        </label>
      ))}
    </div>
  );
}

function StockPage() {
  const load = useCallback(() => api<StockRow[]>("/stock"), []);
  const { data, error, reload } = useLoad(load);
  if (!data) return <Loading error={error} />;
  const save = async (row: StockRow) => {
    await api(`/stock/${row.sku}`, "PUT", row);
    reload();
  };
  return (
    <section>
      <h2>สต๊อกตัวอย่าง</h2>
      <p className="muted">มีผลกับข้อความถัดไปทันที ไม่ต้องเผยแพร่ เมื่อต่อระบบจริงจะอ่านจาก Tokiti แทนหน้านี้</p>
      <table>
        <thead><tr><th>SKU</th><th>สถานะ</th><th>วันของเข้า</th></tr></thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.sku}>
              <td>{row.sku}</td>
              <td>
                <select aria-label={`สถานะ ${row.sku}`} value={row.status} onChange={(event) => save({ ...row, status: event.target.value as StockStatus })}>
                  {Object.entries(STOCK_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </td>
              <td>
                <input aria-label={`วันของเข้า ${row.sku}`} type="date" value={row.restock_date ?? ""} onChange={(event) => save({ ...row, restock_date: nullable(event.target.value) })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <strong>{value}</strong>
      <span className="muted small">{label}</span>
    </div>
  );
}

function Bars({ title, rows, labels }: { title: string; rows: { name: string; total: number }[]; labels: Record<string, string> }) {
  const max = Math.max(1, ...rows.map((row) => row.total));
  return (
    <div className="card">
      <h3>{title}</h3>
      {rows.length === 0 && <p className="muted small">ยังไม่มีข้อมูล</p>}
      {rows.map((row) => (
        <div className="bar" key={row.name}>
          <span>{labels[row.name] ?? row.name}</span>
          <div><i style={{ width: `${(row.total / max) * 100}%` }} /></div>
          <b>{row.total}</b>
        </div>
      ))}
    </div>
  );
}

const percent = (value: number | null) => (value === null ? "-" : `${Math.round(value * 100)}%`);

function TelemetryPage() {
  const load = useCallback(() => api<Telemetry>("/telemetry"), []);
  const { data, error } = useLoad(load);
  if (!data) return <Loading error={error} />;
  return (
    <section>
      <h2>สถิติ</h2>
      <div className="stats">
        <Stat label="คำถามทั้งหมด" value={data.total} />
        <Stat label="ส่งต่อทีมงาน" value={percent(data.handoff_rate)} />
        <Stat label="อนุมัติโดยไม่แก้" value={percent(data.approval_rate)} />
        <Stat label="ถูกกันโดยระบบ" value={data.safety_blocks} />
        <Stat label="เวลาตอบ p50 / p95 (ms)" value={`${data.latency_ms.p50 ?? "-"} / ${data.latency_ms.p95 ?? "-"}`} />
        <Stat label="โทเคน" value={data.tokens.toLocaleString()} />
        <Stat label="ค่าใช้จ่าย (USD)" value={data.cost_usd === null ? "-" : data.cost_usd.toFixed(4)} />
        <Stat label="อ่านสต๊อก / ไม่สำเร็จ" value={`${data.stock_reads.total} / ${data.stock_reads.failed ?? 0}`} />
      </div>
      <Bars title="คำถามตามหัวข้อ" rows={data.by_topic} labels={TOPIC_LABELS} />
      <Bars title="เหตุผลที่ส่งต่อ" rows={data.handoff_reasons} labels={REASON_LABELS} />
      <div className="card">
        <h3>คำถามที่บอทตอบไม่ได้</h3>
        <p className="muted small">ใช้รายการนี้ดูว่าควรเพิ่มข้อมูลอะไร</p>
        {data.unanswered.length === 0 && <p className="muted small">ยังไม่มีข้อมูล</p>}
        <ul>
          {data.unanswered.map((item) => (
            <li key={item.id}>
              {item.text} <span className="muted small">{TOPIC_LABELS[item.topic]}{item.reasons.length ? ` · ${item.reasons.map((reason) => REASON_LABELS[reason] ?? reason).join(", ")}` : ""}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
