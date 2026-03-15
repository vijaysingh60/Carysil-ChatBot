import { NextResponse } from "next/server";
import { callAI } from "@/lib/ai";
import dealersData from "@/data/dealers.json";

const SYSTEM = `You are an AI assistant for Carysil (carysil.com), a premium kitchen and bathroom brand.
Given a lead (name, city, product interest, phone), select the best dealer from the list based on location and product specialization.
Respond with: "Lead Assigned To", then the dealer name, phone, and email. Add one short sentence explaining why this dealer was chosen (location and/or product match).`;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, city, productInterest, phone } = body as {
      name?: string;
      city?: string;
      productInterest?: string;
      phone?: string;
    };
    const userInput = `Lead: Name ${name || "—"}, City ${city || "—"}, Product interest: ${productInterest || "—"}, Phone: ${phone || "—"}. Assign best dealer.`;
    const dataset = JSON.stringify(dealersData, null, 2);

    const placeholder = `## Lead Assigned To

**Hyderabad Kitchen Dealer**
Phone: +91 98765 43210
Email: hyderabad@carysil-dealers.com

This dealer covers Hyderabad and supports kitchen sinks and faucets. They will contact you shortly.`;

    const { text, aiUsed, error } = await callAI(
      SYSTEM,
      `User request:\n${userInput}\n\nAvailable dealers:\n${dataset}\n\nProvide the assigned dealer.`,
      placeholder
    );

    return NextResponse.json({ result: text, aiUsed, error });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: "Failed to route lead" },
      { status: 500 }
    );
  }
}
