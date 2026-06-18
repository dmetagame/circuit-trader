import type { Metadata, Viewport } from "next";
import { Space_Grotesk, Inter, JetBrains_Mono } from "next/font/google";
import { SmoothScroll } from "@/components/SmoothScroll";
import "./globals.css";

/**
 * Type system — "engineered precision", self-hosted via next/font (no layout shift, no
 * external requests). Three roles, exposed as CSS variables consumed in globals.css:
 *   --font-display  Space Grotesk   headlines / wordmark (tight tracking on large sizes)
 *   --font-sans     Inter           body / UI
 *   --font-mono     JetBrains Mono   data / numerals / labels / verdicts / tx hashes (tabular)
 *
 * Easy swaps if you want a different voice:
 *   Alt A — "Vercel-clean":  Geist + Geist Mono            (next/font/google: Geist, Geist_Mono)
 *   Alt B — "Statement":     Clash Display + Satoshi + Space Mono  (self-host Fontshare under apps/web)
 */
const display = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "700"],
  variable: "--font-display",
  display: "swap",
});
const sans = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sans",
  display: "swap",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Circuit Trader — survival is the edge",
  description: "An autonomous BNB-chain trading agent that cannot trade unless its own signed risk constitution allows it.",
  // app/icon.svg, app/apple-icon.png and app/opengraph-image.png are wired automatically
  // by Next's file conventions — no explicit `icons` needed here.
};

export const viewport: Viewport = {
  themeColor: "#0B0E0D",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <SmoothScroll>{children}</SmoothScroll>
      </body>
    </html>
  );
}
