import { test } from "vitest";
import type { SyncElement } from "@limn/protocol";
import { polishSketch } from "./polish";
import type { PolishGroup } from "./schema";

const el = (p: Record<string, unknown>) =>
  ({ type: "freedraw", angle: 0, version: 1, versionNonce: 1, isDeleted: false,
     strokeColor: "#1e1e1e", strokeWidth: 2, roughness: 1, backgroundColor: "transparent", ...p,
  }) as unknown as SyncElement;
const g = (ids: string[], ops: string[]): PolishGroup => ({ ids, label: "wheels", ops }) as unknown as PolishGroup;

function trueBox(e: SyncElement) {
  const pts = (e as unknown as { points: number[][] }).points;
  const xs = pts.map((p) => p[0] as number), ys = pts.map((p) => p[1] as number);
  return { left: +( (e.x as number) + Math.min(...xs)).toFixed(1), right: +((e.x as number) + Math.max(...xs)).toFixed(1),
           top: +((e.y as number) + Math.min(...ys)).toFixed(1), bottom: +((e.y as number) + Math.max(...ys)).toFixed(1) };
}
// A hand-drawn circle centred at (cx,cy), started at angle 0 (its right side),
// which is where a pen lands when you draw a circle... any start but top-left.
function circle(cx: number, cy: number, r: number) {
  const raw: [number, number][] = [];
  for (let i = 0; i < 40; i++) {
    const t = (i / 40) * Math.PI * 2;
    const w = ((i * 7919) % 11) / 5 - 1;
    raw.push([cx + Math.cos(t) * r + w, cy + Math.sin(t) * r + w]);
  }
  const f = raw[0]!;
  return { x: f[0], y: f[1], points: raw.map(([x, y]) => [x - f[0], y - f[1]]),
           width: Math.max(...raw.map(p=>p[0])) - Math.min(...raw.map(p=>p[0])),
           height: Math.max(...raw.map(p=>p[1])) - Math.min(...raw.map(p=>p[1])) };
}

test("PROBE: two wheels, regularize + align-center-y", () => {
  const a = el({ id: "w1", ...circle(200, 400, 30) });
  const b = el({ id: "w2", ...circle(400, 402, 30) });
  console.log("BEFORE w1", trueBox(a), "\nBEFORE w2", trueBox(b));
  const out = polishSketch([a, b], [g(["w1", "w2"], ["regularize", "align-center-y"])]);
  const A = out.elements.find((e) => e.id === "w1")!, B = out.elements.find((e) => e.id === "w2")!;
  console.log("AFTER  w1", trueBox(A), "\nAFTER  w2", trueBox(B));
  console.log("centres y:", (trueBox(A).top+trueBox(A).bottom)/2, (trueBox(B).top+trueBox(B).bottom)/2);
});
