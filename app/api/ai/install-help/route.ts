import { NextResponse } from "next/server";
import { callAI } from "@/lib/ai";
import guidesData from "@/data/installation_guides.json";

const SYSTEM = `You are an AI assistant for Carysil (carysil.com), a premium kitchen and bathroom brand.
Use the installation guides and knowledge base below to answer the user's installation question.
Provide a thorough, step-by-step answer. Include all relevant entries from the knowledge base that match the question (e.g. installation steps, troubleshooting, cleaning). Mention manual or video links from the data when relevant. Be comprehensive.`;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { question } = body as { question?: string };
    const userInput = question || "How do I install a Carysil faucet?";
    const dataset = JSON.stringify(guidesData, null, 2);

    const placeholder = `For **Pull-Out Faucet LX200** installation:

1. Shut off water supply.
2. Remove old faucet and clean the deck.
3. Insert mounting hardware from below.
4. Connect supply lines (cold/hot).
5. Secure with mounting nut.
6. Attach pull-out hose to spout.
7. Turn water on and check for leaks.

**If the sink is leaking:** Check supply line connections under the sink, spout base mounting nut, and pull-out hose connection. Replace cartridge (part# LX200-C) if water drips from spout when off.

**Care (Granite Sink):** Clean with mild soap and soft cloth; avoid bleach/abrasives. For stains use baking soda paste.

Allow 24 hours for sealant to cure. Manual: https://carysil.com/manuals/lx200.pdf`;

    const { text, aiUsed, error } = await callAI(
      SYSTEM,
      `User question:\n${userInput}\n\nKnowledge base:\n${dataset}\n\nProvide a helpful answer.`,
      placeholder
    );

    return NextResponse.json({ result: text, aiUsed, error });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: "Failed to get installation help" },
      { status: 500 }
    );
  }
}
