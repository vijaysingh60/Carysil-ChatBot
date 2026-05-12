import { NextResponse } from "next/server";
import dealersData from "@/data/dealers.json";

type Dealer = {
  id: string;
  name: string;
  city: string;
  state: string;
  products_supported: string[];
  contact_email: string;
  phone: string;
};

const dealers = dealersData as Dealer[];

function normalize(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, " ");
}

function matchesLocation(dealer: Dealer, location: string): boolean {
  const normalizedLocation = normalize(location);
  if (!normalizedLocation) return false;
  const aliases: Record<string, string[]> = {
    bengaluru: ["bangalore"],
    bangalore: ["bangalore"],
    bombay: ["mumbai"],
    ncr: ["gurgaon", "noida", "new delhi", "delhi", "faridabad", "ghaziabad"],
    "delhi ncr": ["gurgaon", "noida", "new delhi", "delhi", "faridabad", "ghaziabad"],
  };
  const searchTerms = aliases[normalizedLocation] || [normalizedLocation];
  const dealerCity = normalize(dealer.city);
  const dealerState = normalize(dealer.state);
  return searchTerms.some(
    (term) =>
      dealerCity.includes(term) ||
      term.includes(dealerCity) ||
      dealerState.includes(term) ||
      term.includes(dealerState)
  );
}

function supportsProduct(dealer: Dealer, productInterest: string): boolean {
  const normalizedInterest = normalize(productInterest);
  if (!normalizedInterest) return false;
  return dealer.products_supported.some((product) => {
    const normalizedProduct = normalize(product);
    return normalizedInterest.includes(normalizedProduct) || normalizedProduct.includes(normalizedInterest);
  });
}

function formatAssignedDealer(dealer: Dealer, productInterest: string): string {
  const productMatch = supportsProduct(dealer, productInterest);
  const reason = productMatch
    ? `This dealer serves ${dealer.city}, ${dealer.state} and supports ${productInterest}.`
    : `This dealer serves ${dealer.city}, ${dealer.state}; please confirm product availability before visiting.`;

  return `## Lead Assigned To

**${dealer.name}**
Phone: ${dealer.phone}
Email: ${dealer.contact_email}

${reason}`;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { city, productInterest } = body as {
      city?: string;
      productInterest?: string;
    };
    const trimmedCity = String(city || "").trim();
    const trimmedInterest = String(productInterest || "").trim();

    if (!trimmedCity) {
      return NextResponse.json({
        result: "Please enter a city or state so we can assign the right Carysil dealer.",
        aiUsed: false,
      });
    }

    const locationMatches = dealers.filter((dealer) => matchesLocation(dealer, trimmedCity));
    if (locationMatches.length === 0) {
      return NextResponse.json({
        result: `No listed Carysil dealer was found for ${trimmedCity}. Please check the city/state spelling or try a nearby major city.`,
        aiUsed: false,
      });
    }

    const productMatches = locationMatches.filter((dealer) => supportsProduct(dealer, trimmedInterest));
    const selectedDealer = productMatches[0] || locationMatches[0];

    return NextResponse.json({
      result: formatAssignedDealer(selectedDealer, trimmedInterest),
      aiUsed: false,
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: "Failed to route lead" },
      { status: 500 }
    );
  }
}
