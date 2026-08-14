import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  // Just the name in the tab. The description below is what carries the
  // explanation into search results and link previews, so the title does not
  // have to do that job as well.
  title: "Limn",
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
  // One colour, not a light/dark pair. The app committed to a single dark
  // world, so following the viewer's preference here just paints the phone's
  // browser chrome white above a near-black page.
  themeColor: "#07080c",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="h-full">{children}</body>
    </html>
  );
}
