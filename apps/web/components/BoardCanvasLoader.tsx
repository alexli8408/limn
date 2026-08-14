"use client";

import dynamic from "next/dynamic";
import type { BoardCanvasProps } from "./BoardCanvas";

/**
 * Keeps the entire canvas module graph off the server.
 *
 * A `"use client"` component is still server-rendered — the directive marks a
 * hydration boundary, not a browser-only one. So marking BoardCanvas as a client
 * component is not enough on its own: importing it from a server component
 * evaluates `@excalidraw/excalidraw` (and everything reaching it, including the
 * AI compiler and the beautify hook) during SSR, where its browser assumptions
 * do not hold.
 *
 * `ssr: false` is only permitted inside a client component, which is the entire
 * reason this file exists as a separate one-line boundary rather than being
 * folded into the page.
 */
const BoardCanvas = dynamic(() => import("./BoardCanvas"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center">
      <span className="text-sm text-neutral-500">Opening board…</span>
    </div>
  ),
});

export default function BoardCanvasLoader(props: BoardCanvasProps) {
  return <BoardCanvas {...props} />;
}
