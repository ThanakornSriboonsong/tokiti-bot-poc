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

Eval results are saved in `evals/results/`.

## Layout

```text
packages/core/  Answer pipeline, safety checks, stock and model adapters
apps/api/       Hono API and local SQLite
apps/web/       Control web and test chat
data/seed/      Sample data
evals/          Test questions, scoring and model shortlist
```

## Important limits

- **Sample data:** every value comes from tokiti-web seed files dated 27 Oct 2026 and needs Kin's confirmation. Prices may be out of date, and stock and orders are invented.
- **Live stock:** `TokitiStockProvider` is ready but off. It needs a read-only endpoint in Tokiti that returns availability by SKU, which needs Kin's approval. Never use the Supabase service-role key here.
- **Privacy:** requests set OpenRouter's `data_collection: "deny"`, and the POC should only receive sample data. Don't use real customer messages or images without Kin's approval.
- **Not production ready:** the API has no login and only listens on your own computer.
