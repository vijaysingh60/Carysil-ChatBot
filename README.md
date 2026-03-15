# Carysil AI Prototype

A Next.js prototype demonstrating four AI-powered features for **Carysil (carysil.com)**, a premium kitchen and bathroom brand. This app is for capability demos only (no database).

## Tech stack

- **Next.js** (App Router), **TypeScript**, **Tailwind CSS**
- Local JSON data in `/data`
- **OpenAI API** (optional); works with placeholder responses if `OPENAI_API_KEY` is not set

## Run locally

```bash
npm install
cp .env.local.example .env.local   # optional: add OPENAI_API_KEY for live AI
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Structure

### Primary demo UI (single chatbot)

- `/` — **Carysil Concierge** (one chatbot that routes requests to products, dealer routing, installation help, or design assistant)

API route used by the chatbot: `/api/ai/concierge`.

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

- **`OPENAI_API_KEY`** — If set, API routes call OpenAI (`gpt-4o-mini`) and you get **full, varied answers** from the real AI. If unset, the app uses **short placeholder responses** (no API call), so you may see only 2–3 items or one fixed answer.
- **No database required.** All data (products, dealers, installation guides) is loaded from the `/data` JSON files at runtime.
