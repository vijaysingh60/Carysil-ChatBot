import type { Metadata } from "next";
import { Outfit } from "next/font/google";
import "./globals.css";
import { LayoutWrapper } from "@/components/LayoutWrapper";
import { ChatWidget } from "@/components/ChatWidget";

const outfit = Outfit({ subsets: ["latin"], variable: "--font-outfit" });

export const metadata: Metadata = {
  title: "Carysil AI | Kitchen & Bathroom",
  description: "AI-powered concierge tools for Carysil kitchen and bathroom",
  icons: {
    icon: "/favicon.webp",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={outfit.variable}>
      <body className="min-h-screen font-sans bg-white">
        <LayoutWrapper>{children}</LayoutWrapper>
        <ChatWidget />
      </body>
    </html>
  );
}
