/**
 * Records the Beautify demo by driving the real app in headless Chrome.
 *
 * Everything on screen is the product doing its job: a real signed-in session, a
 * real board, real pointer events into the canvas, and a real Gemini call. There
 * is no mock and nothing is re-enacted afterwards, which matters because the
 * whole claim of the feature is that it works.
 *
 * Needs, all already on this machine:
 *   - Chrome, driven over CDP. No Playwright or Puppeteer: neither is installed
 *     and both are a large dependency for a dozen protocol calls.
 *   - ffmpeg, for the encode.
 *   - A confirmed account. Anonymous sign-in is off and the debug session route
 *     was removed as a security hole, so there is no shortcut left. Make one
 *     with scripts/demo/account.sh.
 *
 *   pnpm --filter @limn/web dev            # in another shell
 *   ./scripts/demo/account.sh              # prints DEMO_EMAIL / DEMO_PASSWORD
 *   node scripts/demo/capture.mjs          # writes docs/demo.mp4 and docs/demo.gif
 *
 * The daily Gemini allowance is 20 requests. A failed run still spends one, so
 * check the tail of the log for the panel message rather than assuming a file on
 * disk means the run succeeded.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Cdp, sessionCookies, sleep } from "./cdp.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const WORK = resolve(ROOT, ".demo-capture");
const OUT = resolve(ROOT, "docs");

const env = Object.fromEntries(
  readFileSync(resolve(ROOT, ".env"), "utf8")
    .split("\n")
    .map((line) => line.match(/^([A-Z_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);

const SUPABASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const REF = new URL(SUPABASE).hostname.split(".")[0];
const EMAIL = process.env.DEMO_EMAIL;
const PASSWORD = process.env.DEMO_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error("set DEMO_EMAIL and DEMO_PASSWORD, see scripts/demo/account.sh");
  process.exit(64);
}

const post = async (path, body, token) => {
  const response = await fetch(`${SUPABASE}${path}`, {
    method: "POST",
    headers: {
      apikey: ANON,
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return response.json();
};

const session = await post("/auth/v1/token?grant_type=password", {
  email: EMAIL,
  password: PASSWORD,
});
if (!session.access_token) throw new Error(`sign-in failed: ${JSON.stringify(session)}`);

const created = await post("/rest/v1/rpc/create_board", { p_title: "Demo" }, session.access_token);
const boardId = (Array.isArray(created) ? created[0] : created).id;
console.log(`board ${boardId}`);

/* ------------------------------------------------------------------ */
/* the sketch                                                          */
/* ------------------------------------------------------------------ */

/**
 * A house, a sun and a ground line, in CSS pixels.
 *
 * Deliberately a picture rather than a diagram. Beautify used to refuse
 * everything that was not boxes and arrows, so a drawing is the case worth
 * filming, and it is the one the old demo could not show.
 *
 * The wobble is deterministic. A demo that comes out differently every run
 * cannot be compared against the last one when something regresses.
 */
const OX = 300;
const OY = 150;
const K = 0.62;
const at = (x, y) => [OX + x * K, OY + y * K];
const jitter = (n) => (((Math.sin(n * 12.9898) * 43758.5453) % 1) * 5) - 2.5;

const line = (x1, y1, x2, y2, steps = 12) =>
  Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    return at(x1 + (x2 - x1) * t + jitter(i + x1), y1 + (y2 - y1) * t + jitter(i + y1 + 7));
  });

const ring = (cx, cy, r, steps = 36) =>
  Array.from({ length: steps + 1 }, (_, i) => {
    const a = (i / steps) * Math.PI * 2;
    return at(cx + Math.cos(a) * r + jitter(i), cy + Math.sin(a) * r + jitter(i + 3));
  });

const STROKES = [
  line(220, 300, 220, 470),
  line(430, 296, 430, 470),
  line(220, 300, 430, 296),
  line(220, 470, 430, 470),
  line(210, 300, 325, 205),
  line(325, 205, 440, 300),
  line(300, 380, 300, 470),
  line(350, 384, 350, 470),
  line(300, 380, 350, 384),
  ring(700, 180, 62),
  line(700, 90, 700, 55, 5),
  line(790, 180, 828, 180, 5),
  line(766, 114, 792, 88, 5),
  line(90, 500, 830, 504, 24),
];

/* ------------------------------------------------------------------ */
/* drive                                                              */
/* ------------------------------------------------------------------ */

const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("no Chrome on :9222, see scripts/demo/chrome.sh");

const cdp = await Cdp.attach(page.webSocketDebuggerUrl);
await cdp.send("Page.enable");
await cdp.send("Network.enable");
await cdp.send("Runtime.enable");
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 800,
  deviceScaleFactor: 2,
  mobile: false,
});

for (const cookie of sessionCookies(REF, session, "localhost")) {
  await cdp.send("Network.setCookie", { ...cookie, url: "http://localhost:3000" });
}

await cdp.send("Page.navigate", { url: `http://localhost:3000/board/${boardId}` });
await sleep(9000);

const evaluate = async (expression) =>
  (await cdp.send("Runtime.evaluate", { expression, returnByValue: true })).result.value;

const clickTool = (prefix) =>
  evaluate(
    `[...document.querySelectorAll('.App-toolbar [title]')]` +
      `.find(n=>n.getAttribute('title').startsWith(${JSON.stringify(prefix)}))?.click()`,
  );

const clickButton = (pattern) =>
  evaluate(
    `(() => { const m = [...document.querySelectorAll("button")]` +
      `.filter(b => ${pattern}.test(b.textContent.trim())); ` +
      `(m[m.length-1] || m[0])?.click(); return m.length; })()`,
  );

// Snap straightens a single stroke the moment the pen lifts, which would tidy
// the sketch before Beautify ever sees it and make the film a lie.
await evaluate(
  `[...document.querySelectorAll("button")].find(b=>/^Snap on/.test(b.textContent.trim()))?.click()`,
);
await sleep(400);

async function stroke(points) {
  // Re-picked every time: without the tool lock Excalidraw drops back to the
  // selection tool after each stroke, so strokes two onward would be drags.
  await clickTool("Draw");
  await sleep(60);
  const [x0, y0] = points[0];
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: x0, y: y0, button: "left", clickCount: 1, buttons: 1,
  });
  for (const [x, y] of points.slice(1)) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved", x, y, button: "left", buttons: 1,
    });
  }
  const [xe, ye] = points[points.length - 1];
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: xe, y: ye, button: "left", clickCount: 1, buttons: 0,
  });
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const stamps = [];
cdp.on("Page.screencastFrame", async ({ data, sessionId }) => {
  writeFileSync(`${WORK}/f${String(stamps.length).padStart(5, "0")}.png`, Buffer.from(data, "base64"));
  stamps.push(performance.now() / 1000);
  try {
    await cdp.send("Page.screencastFrameAck", { sessionId });
  } catch {
    /* the cast is already stopping */
  }
});

await cdp.send("Page.startScreencast", { format: "png", quality: 100, everyNthFrame: 1 });
await sleep(700);

for (const points of STROKES) {
  await stroke(points);
  await sleep(110);
}

// Back to selection, or Excalidraw's stroke-properties panel sits over the
// drawing for the rest of the film.
await clickTool("Selection");
await sleep(900);

await clickButton("/Beautify/");
await sleep(700);
await clickButton("/^Beautify$/");

let settled = null;
for (let i = 0; i < 120; i++) {
  await sleep(500);
  settled = await evaluate(
    `(document.body.innerText.match(/Tidied[^\\n]*|already looks tidy[^\\n]*|Out of Gemini[^\\n]*|could not[^\\n]*/)||[])[0] || null`,
  );
  if (settled) break;
}
await sleep(2600);
await cdp.send("Page.stopScreencast");
cdp.close();

console.log(`frames ${stamps.length}, panel: ${settled ?? "(nothing reported)"}`);
if (!settled || /Out of Gemini|could not/i.test(settled)) {
  console.error("the run did not beautify anything; not encoding");
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* encode                                                             */
/* ------------------------------------------------------------------ */

// Real frame durations rather than a fixed rate: the screencast only emits on a
// repaint, so a fixed rate makes the drawing race and the wait for the model
// crawl. Clamped so one slow frame does not freeze the film.
const list = stamps
  .map((t, i) => {
    const next = i + 1 < stamps.length ? stamps[i + 1] - t : 0.08;
    return `file '${WORK}/f${String(i).padStart(5, "0")}.png'\nduration ${Math.min(Math.max(next, 0.02), 0.5).toFixed(3)}`;
  })
  .join("\n");
writeFileSync(`${WORK}/concat.txt`, `${list}\nfile '${WORK}/f${String(stamps.length - 1).padStart(5, "0")}.png'\n`);

mkdirSync(OUT, { recursive: true });
const ff = (args) => execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);

ff(["-f", "concat", "-safe", "0", "-i", `${WORK}/concat.txt`,
    "-vf", "fps=24,scale=1000:-2:flags=lanczos",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", `${OUT}/demo.mp4`]);

// A shared palette, or a GIF of a dark UI bands badly in the gradients.
ff(["-i", `${OUT}/demo.mp4`, "-vf", "fps=16,scale=800:-2:flags=lanczos,palettegen=stats_mode=diff", `${WORK}/palette.png`]);
ff(["-i", `${OUT}/demo.mp4`, "-i", `${WORK}/palette.png`,
    "-lavfi", "fps=16,scale=800:-2:flags=lanczos[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=3",
    `${OUT}/demo.gif`]);

console.log(`wrote ${OUT}/demo.mp4 and ${OUT}/demo.gif`);
