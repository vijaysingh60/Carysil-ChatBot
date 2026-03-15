import { NextResponse } from "next/server";
import { callAI } from "@/lib/ai";
import productsData from "@/data/products.json";

const SYSTEM = `You are an AI assistant for Carysil (carysil.com), a premium kitchen and bathroom brand.
Architects describe their project; suggest compatible Carysil products from the catalogue.
Respond with a "Recommended Design Setup" section: list ALL relevant products from the catalogue that fit the project (aim for 4-6 or more). For each give product name and a brief explanation. Use bullet points. Be thorough.`;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { description } = body as { description?: string };
    const userInput = description || "Luxury bathroom with modern fittings.";
    const dataset = JSON.stringify(productsData, null, 2);

    const placeholder = `## Recommended Design Setup

- **Wall Mounted Basin BX400** — Sleek, minimal; fits contemporary bathrooms.
- **Matte Black Mixer Tap MK330** — Matches black fittings and luxury villa aesthetic.
- **Rain Shower System RS800** — Premium rain shower option.
- **Luxury Drain System DS-Pro** — Concealed drain for a clean look.
- **Round Pedestal Basin RP-220** — Classic option for luxury villa bathrooms.`;

    const { text, aiUsed, error } = await callAI(
      SYSTEM,
      `Architect project description:\n${userInput}\n\nProduct catalogue:\n${dataset}\n\nSuggest compatible products with short explanations.`,
      placeholder
    );

    return NextResponse.json({ result: text, aiUsed, error });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: "Failed to get design suggestions" },
      { status: 500 }
    );
  }
}
