import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });

export const metadata: Metadata = {
  title: "GiftWave — Gift your favorite creators. They keep 100%.",
  description:
    "Send gifts, cash, and digital items to creators you love. Zero commission, instant payouts, complete privacy.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en" className={`${geist.variable} h-full antialiased`}>
        <body className="min-h-full bg-white text-gray-900">{children}</body>
      </html>
    </ClerkProvider>
  );
}
