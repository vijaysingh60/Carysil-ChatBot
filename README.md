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

Initialize/sync vectors in another terminal:

```bash
npm run embed:products
```

Run app:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Structure

### Primary demo UI (single chatbot)

- `/` — **Carysil Concierge** (one chatbot that routes requests to products, dealer routing, installation help, or design assistant)

API route used by the chatbot: `/api/ai/concierge`.
This route now performs hybrid retrieval:
1) query embedding generation via Flask service
2) `pgvector` similarity search (`ORDER BY embedding <=> $1`)
3) SQL filters for user constraints (material/style/keywords/budget)
4) only top relevant products are sent to OpenAI for response generation

### Legacy single-feature pages (optional)

These pages still exist in the prototype but are no longer the primary demo UI:

- `/kitchen-recommendation`
- `/dealer-routing`
- `/installation-help`
- `/design-assistant`

Other API routes: `/api/ai/recommend-products`, `/api/ai/dealer-routing`, `/api/ai/install-help`, `/api/ai/design-assistant`.

## Data

- `data/products.json` — Kitchen & bathroom products (name, category, style, material, price_range, description)
- `data/dealers.json` — Dealers (name, city, state, products_supported, contact_email, phone)
- `data/installation_guides.json` — Installation guides (product, issue, solution, video_link, manual_link)

## Environment

- **`OPENAI_API_KEY`** — If set, API routes call OpenAI (`gpt-4o-mini`) for natural recommendation responses.
- **`DATABASE_URL`** — Required for product vector retrieval.
- **`EMBEDDING_API_URL`** — URL for sentence-transformer embedding service (default `http://127.0.0.1:5001`).

## Vector schema

SQL migration is available at `db/products_vector_schema.sql`.
It creates:
- `products` table with metadata + `embedding VECTOR(384)`
- IVFFlat cosine index (`products_embedding_cosine_idx`) for retrieval performance
