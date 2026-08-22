# Limn

A realtime collaborative whiteboard. Rough strokes become clean shapes as you
draw, and a whole messy sketch can be redrawn as a proper diagram without
changing what you meant by it.

```
  Next.js 16 / React 19 / Excalidraw ──┐
                                       ├── Vercel
  Supabase Realtime (Broadcast + Presence, WebSocket)
  Supabase Postgres (RLS, SECURITY DEFINER RPCs)
  Gemini 3.x (constrained-schema decoding)
                                       ┌── Render (+ UptimeRobot keepalive)
  FastAPI / OpenCV 4.10 ───────────────┘
```

---

## What it does

**Draws with you.** Every freehand stroke is classified the moment the pen
lifts and replaced with a real rectangle, ellipse, diamond, triangle, line or
arrow, in the same frame and entirely client-side. When it isn't sure it leaves
your stroke alone. When it is wrong, one Ctrl+Z gives you the wobble back.

**Collaborates without a server.** Sync rides Supabase Realtime, which is a
WebSocket fan-out with no place to run code. So convergence, persistence and
catch-up are all peer-side: concurrent edits merge under a total order on
`(version, versionNonce)`, and the peers deterministically elect one of
themselves from the presence map to persist the board.

**Reads a physical whiteboard.** Photograph one and OpenCV flattens the
perspective, separates ink from board under glare and uneven lighting, thins the
ink to a one-pixel centreline, walks that into polylines and fits real shapes you
can edit. Not a traced image. OpenCV is good at edges and hopeless at cursive, so
the handwriting is a second pass: Gemini transcribes each label and says where on
the board it sits, and the words land back in the boxes they were written in.

**Beautifies without rewriting.** Gemini reads a sketch, as both an image and an
element list, and returns structure rather than scene JSON. A deterministic
compiler places it. Your arrangement survives, and the arrows are properly bound
rather than merely adjacent.

It works on drawings, not only diagrams. A picture has no node-and-edge form to
be rewritten into, so the model instead groups the strokes you already drew and
says what each group is: these five are the house, square it up and line up its
baselines. Every coordinate is derived from the elements already on the canvas,
so nothing is replaced and nothing is lost.

![A wobbly hand-drawn house and sun, beside the same drawing with straight walls,
a true circle and a level ground line](docs/beautify-before-after.png)

That is the real output, and the grouping is the model's own: it split the
strokes into the house body, the roof, the door, the sun, its rays and the
ground line, and chose what tidying each one wanted. Reproduce it with
`pnpm exec vitest run lib/ai/polish.integration.test.ts`, which needs a
`GEMINI_API_KEY` and skips without one.

---

## Measured results

Every number here comes from a suite in this repo, and each one is reproducible
with the command beside it.

| | Result | Reproduce |
|---|---|---|
| Stroke recognition accuracy | **95.8%** over 600 synthetic strokes (5 primitives, a third of them rotated, with hand-tremor and closing-overshoot artefacts) | `pnpm --filter @limn/shapes test` |
| Photo to diagram | **4/4** drawn primitives recovered with correct dimensions from a synthesised photo (perspective warp, illumination gradient, glare hotspot, sensor noise), in **~57 ms** | `cd apps/vision && pytest tests -q` |
| Merge convergence | 5 simulated peers over 40 rounds of randomised delivery order, batching and replays. **No divergence**, no duplicates, no holes | `pnpm --filter @limn/protocol test` |
| Access control | 23 checks on RLS, privilege escalation, share-link redemption and snapshot compare-and-swap, against real Postgres | `./supabase/tests/run.sh` |
| Test suites | **76 tests** across TypeScript and Python, plus the SQL checks above | `pnpm test` |

Realtime throughput and latency depend on your own Supabase project, so they are
not quoted here. Measure yours:

```bash
set -a && source .env && set +a
pnpm loadtest --peers 25 --duration 30 --rate 8
```

It opens real WebSockets, embeds a send timestamp in the payload and reads it
back at the receivers, so the reported p50/p95/p99 is the full round trip through
Supabase rather than local send time. Results land in `loadtest-results/`.

---

## Two bugs worth reading about

Both were found by asserting a property rather than by reading the code, and both
are documented at the fix.

**Discarding a tombstone for an unknown element breaks convergence.** It looks
like an obvious optimisation. Why store a delete for something you don't have?
But it silently loses the delete. A peer that loaded a snapshot after the
deletion, then received a stale broadcast of the element from a peer who hadn't
processed it yet, would resurrect the element permanently.
[`reconcile.ts`](packages/protocol/src/reconcile.ts)

**`rectFill` cannot separate a diamond from a rectangle.** A diamond's minimal
enclosing rectangle is edge-aligned, not axis-aligned, so area-over-rect measures
about 0.75 rather than the textbook 0.5 and overlaps the rectangle case entirely.
Replaced with a rotation-invariant test on the quadrilateral's diagonals. That,
plus switching score combination from a product to a weighted geometric mean,
took recognition from 65% to 95.8%. [`recognize.ts`](packages/shapes/src/recognize.ts)

---

## Layout

```
apps/
  web/          Next.js app: canvas, collab hook, AI routes         -> Vercel
  vision/       FastAPI + OpenCV: photo vectorisation, deep fit     -> Render
packages/
  protocol/     Broadcast events, merge rules, writer election
  shapes/       Geometry recogniser and alignment engine
supabase/
  migrations/   Schema, RLS, Realtime authorization, storage
  tests/        Applies migrations to throwaway Postgres and asserts security
scripts/
  loadtest.ts   Realtime load harness
```

`packages/protocol` deliberately does not import Excalidraw. It is consumed by
the Node load harness and must stay independent of the drawing SDK's release
cadence. Sync only needs the four fields that drive conflict resolution.

---

## Running it

Needs Node 22+, pnpm 11+, Python 3.11 or 3.12, and a Supabase project.

```bash
pnpm install
cp .env.example .env && cp .env.example apps/web/.env.local   # then fill both in

# database
supabase init && supabase link --project-ref <ref> && supabase db push

# vision service
cd apps/vision && python3.11 -m venv .venv
./.venv/bin/pip install -r requirements.txt && cd ../..

pnpm dev        # web :3000, vision :8000
```

Two things in the Supabase dashboard, both under **Authentication**. Enable the
**Google** provider, and decide what to do about **Email → Confirm email**: left
on, every signup goes through Supabase's shared SMTP, which is capped at a couple
of messages an hour and fails the signup outright when you hit it. Realtime
private channels need no toggle; the migrations install the `realtime.messages`
policies that authorize them.

[docs/SETUP.md](docs/SETUP.md) is the step-by-step from nothing, including which
dashboard toggles matter and a smoke test that isolates each subsystem.
[docs/DEPLOY.md](docs/DEPLOY.md) is the deployment reference, including the
UptimeRobot keepalive that stops Render's free instance sleeping through a
50-second cold start.
Design decisions and the reasoning behind them are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Notes on the stack

**Excalidraw, not tldraw.** tldraw's licence renders a watermark.

**Supabase Realtime, not a socket server.** One less service to run, and the
Realtime authorization policies mean channel access is enforced by the same RLS
that guards the tables. The cost is that there is no server-side hook, which is
what makes the peer-side convergence work necessary.

**Gemini returns an IR, not Excalidraw elements.** A scene needs `seed`,
`versionNonce`, fractional `index`, `boundElements` cross-references and arrow
binding focus/gap values to all agree. A language model produces something that
looks right and renders as a pile of unbound arrows. The model gets a small
vocabulary and a compiler does the bookkeeping.

**Layout is hand-written, not model-chosen.** A Sugiyama pass: break cycles,
rank, barycentre ordering, coordinate assignment. Asking for coordinates gets
overlaps, drift, and different results for identical requests.
