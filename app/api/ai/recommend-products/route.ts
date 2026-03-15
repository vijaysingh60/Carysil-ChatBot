import { NextResponse } from "next/server";
import { callAI } from "@/lib/ai";
import productsData from "@/data/products.json";

const SYSTEM = `You are an AI assistant for Carysil (carysil.com), a premium kitchen and bathroom brand.
Use the following product catalogue and data to answer the user's request.
Respond with a clear "Recommended Products" section: list ALL relevant products from the catalogue that match the user's style, budget, and kitchen size (aim for 4-6 or more where applicable). For each product give the name and a short reason it fits (one line).
Use markdown-style headers and bullet points. Be thorough and helpful.`;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { style, budget, size } = body as {
      style?: string;
      budget?: string;
      size?: string;
    };
    const userInput = `Kitchen style: ${style || "Not specified"}. Budget: ${budget || "Not specified"}. Kitchen size: ${size || "Not specified"}. Recommend suitable Carysil products.`;
    const dataset = JSON.stringify(productsData, null, 2);

    const placeholder = `## Recommended Products

- **Granite Sink SGX-550** — Suitable for modern kitchens with durable material.
- **Pull-Out Faucet LX200** — Ideal for medium-sized luxury kitchens.
- **Compact Stainless Sink CS-180** — Space-saving for smaller kitchens.
- **Standard Kitchen Faucet KF-100** — Good value for smaller spaces.
- **Hand Shower HS-450** — Flexible option for bathroom or kitchen utility.`;

    const { text, aiUsed, error } = await callAI(
      SYSTEM,
      `User request:\n${userInput}\n\nAvailable data:\n${dataset}\n\nProvide helpful recommendations.`,
      placeholder
    );

    return NextResponse.json({ result: text, aiUsed, error });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: "Failed to get recommendations" },
      { status: 500 }
    );
  }
}
