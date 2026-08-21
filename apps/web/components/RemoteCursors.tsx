"use client";

import { useEffect, useRef, useState } from "react";
import { sceneCoordsToViewportCoords } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { CursorState, PeerState } from "@limn/protocol";

interface Props {
  cursors: Map<string, CursorState & { peer: PeerState }>;
  api: ExcalidrawImperativeAPI | null;
}

/**
 * Remote cursors, drawn as an overlay above the canvas.
 *
 * Positions arrive in scene coordinates, which is the only sane choice on the
 * wire, a viewport coordinate is meaningless to a peer at a different zoom or
 * scroll offset. They are projected to screen space here, on every animation
 * frame, so the cursors track correctly while the local user pans and zooms.
 */
export default function RemoteCursors({ cursors, api }: Props) {
  const [, forceRender] = useState(0);
  const lastView = useRef({ scrollX: 0, scrollY: 0, zoom: 0 });

  useEffect(() => {
    if (!api || cursors.size === 0) return;
    let frame = 0;
    const tick = () => {
      // Re-render only when the projection actually moved. A cursor arriving or
      // moving already re-renders through the `cursors` prop, so the only thing
      // this loop exists for is the local user panning and zooming, which
      // changes where a remote cursor should be drawn without changing any of
      // its own data. Rendering unconditionally meant a permanent 60fps React
      // render for as long as anyone else was on the board.
      const view = api.getAppState();
      const zoom = view.zoom?.value ?? 1;
      const previous = lastView.current;
      if (
        view.scrollX !== previous.scrollX ||
        view.scrollY !== previous.scrollY ||
        zoom !== previous.zoom
      ) {
        lastView.current = { scrollX: view.scrollX, scrollY: view.scrollY, zoom };
        forceRender((n) => (n + 1) % 1_000_000);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [api, cursors.size]);

  if (!api || cursors.size === 0) return null;
  const appState = api.getAppState();

  // z-index 3 is not arbitrary. Excalidraw stacks its static canvas at 1 and its
  // interactive canvas at 2, and both are opaque, so an overlay left at the
  // default `auto` paints underneath them and is never seen. Its own UI layer
  // sits at 4, which cursors should stay below so they cannot cover the toolbar.
  return (
    <div className="pointer-events-none absolute inset-0 z-[3] overflow-hidden">
      {[...cursors.values()].map((cursor) => {
        // sceneCoordsToViewportCoords returns page coordinates: it adds the
        // Excalidraw container's own offsetLeft/offsetTop. This overlay is a
        // sibling inside that same container, so its origin is already there
        // and adding the offset again pushes every cursor down by the height of
        // the header. Subtracting it puts them back on the pointer.
        const point = sceneCoordsToViewportCoords(
          { sceneX: cursor.x, sceneY: cursor.y },
          appState,
        );
        const x = point.x - (appState.offsetLeft ?? 0);
        const y = point.y - (appState.offsetTop ?? 0);
        // Skip anything off-screen rather than letting the browser lay out
        // hundreds of absolutely positioned nodes outside the viewport.
        if (x < -80 || y < -80 || x > window.innerWidth + 80 || y > window.innerHeight + 80) {
          return null;
        }

        const age = Date.now() - (cursor.receivedAt ?? 0);
        return (
          <div
            key={cursor.peer.peerId}
            className="absolute transition-opacity duration-300"
            style={{
              transform: `translate(${x}px, ${y}px)`,
              opacity: age > 5000 ? 0.35 : 1,
            }}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" className="drop-shadow-sm">
              <path
                d="M2 2 L2 15 L6 11.5 L9 18 L11.5 17 L8.5 10.5 L14 10.5 Z"
                fill={cursor.peer.color}
                stroke="#ffffff"
                strokeWidth="1.2"
              />
            </svg>
            <span
              className="ml-3 -mt-1 inline-block max-w-[160px] truncate rounded px-1.5 py-0.5 text-[11px] font-medium text-white"
              style={{ backgroundColor: cursor.peer.color }}
            >
              {cursor.peer.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}
