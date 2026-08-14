"use client";

import { useEffect, useState } from "react";
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

  useEffect(() => {
    if (!api || cursors.size === 0) return;
    let frame = 0;
    const tick = () => {
      forceRender((n) => (n + 1) % 1_000_000);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [api, cursors.size]);

  if (!api || cursors.size === 0) return null;
  const appState = api.getAppState();

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {[...cursors.values()].map((cursor) => {
        const { x, y } = sceneCoordsToViewportCoords(
          { sceneX: cursor.x, sceneY: cursor.y },
          appState,
        );
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
