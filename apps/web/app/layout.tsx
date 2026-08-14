import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Limn — realtime collaborative whiteboard",
  description:
    "Sketch together in realtime. Freehand strokes snap to clean shapes, and Gemini redraws a rough sketch as a proper diagram without changing what you meant.",
  openGraph: {
    title: "Limn",
    description: "Realtime collaborative whiteboard with stroke beautification.",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="h-full">{children}</body>
    </html>
  );
}
