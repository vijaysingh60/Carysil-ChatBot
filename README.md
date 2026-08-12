# Carysil AI Prototype

A Next.js prototype demonstrating AI-powered features for **Carysil (carysil.com)**, a premium kitchen and bathroom brand.

## Tech stack

- **Next.js** (App Router), **TypeScript**, **Tailwind CSS**
- Local JSON data in `/data` (source dataset)
- PostgreSQL + `pgvector` for semantic product retrieval
- Python Flask embedding service with Sentence Transformers (`all-MiniLM-L6-v2`)
- **OpenAI API** (optional); works with placeholder responses if `OPENAI_API_KEY` is not set

## Run locally

```bash
npm install
cp .env.local.example .env.local
```

Set in `.env.local`:
- `DATABASE_URL` (PostgreSQL with `pgvector` extension enabled)
- `EMBEDDING_API_URL` (defaults to `http://127.0.0.1:5001`)
- `OPENAI_API_KEY` (optional but recommended)

Start embedding service:

```bash
cd embedding-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Initialize/sync catalogue and knowledge base in another terminal (embedding service must be running):

```bash
npm run import:catalog
npm run import:documents
npm run embed:products
```

- `import:catalog` — upserts scraped products into Postgres with `features` / `specifications` from `technical_details` (needed for architect/spec answers), then rebuilds the product IVFFlat index
- `import:documents` — embeds FAQs from `data/documents/faqs.json` into the `documents` table (needed for installation/support RAG), then rebuilds the document IVFFlat index
- `embed:products` — backfills product embeddings if the catalog import skipped them

> IVFFlat indexes must be rebuilt after the first embedding load (import scripts do this). Creating them on an empty table with a high `lists` value makes nearest-neighbor search miss true matches.

Run app:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Structure

### Primary demo UI (single chatbot)

- `/` — **AskCary** landing page
- `/concierge` — the chatbot UI
- `/embed/chat` — embeddable widget
- `/dashboard` — internal analytics/leads dashboard

API route used by the chatbot: `/api/ai/concierge`. This is a single orchestrator route
(with logic split into `app/api/ai/concierge/handlers/*`) that routes each message to
product recommendation, dealer routing, lead capture, installation support, or architect/spec assistance. It performs
hybrid retrieval for products:
1) query embedding generation via Flask service
2) `pgvector` similarity search (`ORDER BY embedding <=> $1`)
3) SQL filters for user constraints (material/style/keywords/budget)
4) only top relevant products are sent to OpenAI for response generation

**Installation support** answers from retrieved FAQ/guide documents and escalates to a dealer when guidance is missing or only says “refer to the manual.”
**Architect support** (sticky professional persona) answers from ranked catalog specifications plus gated reference documents — never invents dimensions or certifications.

Other API routes: `/api/ai/status`, `/api/ai/track-click`, `/api/cron/decay-leads`.

## Data

- `data/products.json` — Kitchen & bathroom products (name, category, style, material, price_range, description)
- `data/categories/` + `data/categories2/` — scraped catalogue with `technical_details` (source for `import:catalog`)
- `data/documents/faqs.json` — Carysil FAQ entries (source for `import:documents`)
- `data/dealers.json` — Dealers (name, city, state, products_supported, contact_email, phone)

## Environment

- **`OPENAI_API_KEY`** — If set, API routes call OpenAI (`gpt-4o-mini`) for natural recommendation responses.
- **`DATABASE_URL`** — Required for product vector retrieval.
- **`EMBEDDING_API_URL`** — URL for sentence-transformer embedding service (default `http://127.0.0.1:5001`).

## Vector schema

SQL migration is available at `db/products_vector_schema.sql`.
It creates:
- `products` table with metadata + `embedding VECTOR(384)`

No ANN index on `embedding` below ~5,000 rows — see
`db/migrations/2026_08_drop_undersized_ivfflat_indexes.sql`. An IVFFlat index
this small (hundreds of rows) returns fewer/wrong neighbors than an exact
sequential scan, which costs only single-digit milliseconds at this size.
`scripts/importCatalogProducts.ts` / `scripts/importDocuments.ts` only
(re)build the index once the corpus crosses that threshold.

## RAG evaluation

```bash
npm run rag:dataset       # regenerate eval/golden-dataset.json from the live DB (no fabricated answers)
npm run rag:eval:retrieval   # Recall@K / Precision@K / MRR for hybrid vs vector-only retrieval — no server needed
npm run rag:eval:generation  # end-to-end checks (no-answer, hallucination, injection, citations) — requires `npm run dev` running
npm run rag:evaluate         # both, in sequence
```

Reports are written to `eval/retrieval-report.json` and `eval/generation-report.json`.
