import type { Metadata } from "next";
import { Space_Grotesk, JetBrains_Mono, Fraunces } from "next/font/google";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
});

const fraunces = Fraunces({
  variable: "--font-serif",
  subsets: ["latin"],
  weight: "variable",
});

export const metadata: Metadata = {
  title: "AgentRail — Coding agents that close tickets, end-to-end",
  description:
    "AgentRail is the API layer between your AI coding agents and your dev tools. One integration. Real task lifecycle. No prompt engineering required.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${spaceGrotesk.variable} ${jetbrainsMono.variable} ${fraunces.variable}`}
      style={{ background: "#e6ebf0" }}
    >
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
