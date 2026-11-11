# TOKITI bot POC

A proof of concept for answering TOKITI's LINE customer questions, with a control web for staff. It runs on sample data and sends nothing to customers.

## Run it

Needs Node 22.5 or newer.

```bash
npm install
```

```bash
copy .env.example .env
```

Add `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` to `.env`, then:

```bash
npm run dev
```

Open http://127.0.0.1:5173. Without a key, everything works except getting an answer from the bot.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Runs the unit and API tests. No key or credit needed |
| `npm run typecheck` | Checks types |
| `npm run seed` | Resets the local database to sample data, which deletes local edits and telemetry |
| `npm run shortlist` | Lists OpenRouter models that support tools, JSON schema and images, cheapest first |
| `npm run eval -- --models a/b,c/d` | Runs the test questions on each model. **This spends OpenRouter credit.** Add `--limit 20` for a small trial |
| `npm run eval -- --models a/b --retrieval` | The same, but the bot sees only retrieved sources. Add `--embedding-model x/y` for hybrid search. **Spends credit** |
| `npm run eval:retrieval` | Checks whether word search finds the sources each test question needs. No key or credit needed |

Eval results are saved in `evals/results/`. Runs with retrieval get a `__rag-lexical` or `__rag-hybrid` suffix.

## Retrieval (RAG)

Off by default. When it's off, every approved source goes in the prompt, as before. Turn it on in **ตั้งค่าบอท → การค้นข้อมูล (RAG)**, then publish.

When it's on:

1. Before the model call, `packages/core/src/retrieval.ts` searches the approved sources with the latest message plus the previous customer message, so follow-ups like "แล้วมีของไหม" still work.
2. Word search splits Thai with `Intl.Segmenter` and ranks with BM25. Product names and spec aliases give a direct hit. A product brings its spec and its other colours, and a promotion brings the other promotions.
3. If `OPENROUTER_EMBEDDING_MODEL` is set, vector search through OpenRouter's embeddings endpoint is fused with word search. Source vectors are cached in memory. If embedding fails, word search still runs and the result shows the error.
4. The model sees only the top sources, and can call `search_knowledge` if they aren't enough. It may cite only what it was shown, so citing anything else hands off to staff. Stock and orders still come only from tools.
5. A message with nothing to search, such as a photo without text, gets every source.

FAQ entries have an optional **คำค้นเพิ่ม** field for words customers use. It's used for search only and never shown to the model.

With the current 17 sample sources, sending everything works fine and is cheap. Retrieval starts to pay off once there are many more articles. Word search finds the needed sources for 98.7% of the test questions, but it was tuned on these same questions, so treat that number as an upper bound.

**Measured on 11 Nov 2026 (Haiku 5.5, 176 cases): keep it off for now.**

| Setup | Passed | Wrong price | USD per 1,000 |
|---|---|---|---|
| Every source (two runs) | 169, 164 | 0 | 1.02 |
| Retrieval, first prompt wording | 152 | 0 | 0.95 |
| Retrieval, current wording | 149 | 0 | 0.92 |

The same setup varies by about 5 cases between runs, so the drop is real. Search found the right sources. The model still handed off on promotion and price questions, saying it would check with the team first. Fix that and re-measure before turning retrieval on.

In PowerShell, `npm run eval -- ...` loses its flags because PowerShell strips `--`. Call `node --disable-warning=ExperimentalWarning --import tsx evals/run.ts --models ... --retrieval` directly, and check that the summary's `retrieval` column says what you meant.

## Hosted test copy

`render.yaml` deploys one Render web service that serves both the API and the control web. It needs two secrets, set only in Render: `OPENROUTER_API_KEY` and `APP_PASSWORD`. The login username is `tokiti`.

The server refuses to start on a public address without `APP_PASSWORD`, and `DAILY_CHAT_LIMIT` caps bot calls per day. On Render's free plan, the app sleeps when idle and resets to sample data on every restart, including its telemetry and edits. Pushes don't deploy on their own, so use **Manual Deploy** in Render.

## Layout

```text
packages/core/  Answer pipeline, retrieval, safety checks, stock and model adapters
apps/api/       Hono API and local SQLite
apps/web/       Control web and test chat
data/seed/      Sample data
evals/          Test questions, scoring and model shortlist
```

## Important limits

- **Sample data:** every value comes from tokiti-web seed files dated 27 Oct 2026 and needs Kin's confirmation. Prices may be out of date, and stock and orders are invented.
- **Live stock:** `TokitiStockProvider` is ready but off. It needs a read-only endpoint in Tokiti that returns availability by SKU, which needs Kin's approval. Never use the Supabase service-role key here.
- **Privacy:** requests set OpenRouter's `data_collection: "deny"`, and the POC should only receive sample data. Don't use real customer messages or images without Kin's approval.
- **Not production ready:** one shared password protects the hosted copy, and there are no individual accounts or roles.
