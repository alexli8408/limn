# Limn

A realtime collaborative whiteboard where rough strokes become clean shapes as
you draw, and a whole messy sketch can be redrawn as a proper diagram without
changing what you meant by it.

```
  Next.js 16 / React 19 / Excalidraw ──┐
                                       ├── Vercel
  Supabase Realtime (Broadcast + Presence, WebSocket)
  Supabase Postgres (RLS, SECURITY DEFINER RPCs)
  Gemini 2.5 (constrained-schema decoding)
                                       ┌── Render (+ UptimeRobot keepalive)
  FastAPI / OpenCV 4.10 ───────────────┘
```

---

## What it does

**Draws with you.** Every freehand stroke is classified the moment the pen
lifts and replaced with a real rectangle, ellipse, diamond, triangle, line or
arrow — in the same frame, entirely client-side. When it isn't sure, it leaves
your stroke alone; when it is wrong, one Ctrl+Z gives you the wobble back.

**Collaborates without a server.** Sync rides Supabase Realtime, which is a
WebSocket fan-out with no place to run code. So convergence, persistence and
catch-up are all peer-side: concurrent edits merge under a total order on
`(version, versionNonce)`, and the peers deterministically elect one of
themselves from the presence map to persist the board.

**Reads a physical whiteboard.** Photograph one and OpenCV flattens the
perspective, separates ink from board under glare and uneven lighting, thins the
ink to a one-pixel centreline, walks that into polylines and fits real shapes you
can edit — not a traced image.

**Beautifies without rewriting.** Gemini reads a sketch (as both an image and an
element list) and returns *structure*, never scene JSON. A deterministic
compiler places it. Your arrangement survives, and the arrows are genuinely
bound rather than merely adjacent.

---

## Measured results

Every number here comes from a suite in this repo, and each one is reproducible
with the command beside it.

| | Result | Reproduce |
|---|---|---|
| Stroke recognition accuracy | **95.8%** over 600 synthetic strokes (5 primitives, a third of them rotated, hand-tremor and closing-overshoot artefacts applied) | `pnpm --filter @limn/shapes test` |
| Photo → diagram | **4/4** drawn primitives recovered with correct dimensions from a synthesised photo (perspective warp + illumination gradient + glare hotspot + sensor noise), in **~57 ms** | `cd apps/vision && pytest tests -q` |
| Merge convergence | 5 simulated peers × 40 rounds of randomised delivery order, batching and replays — **no divergence**, no duplicates, no holes | `pnpm --filter @limn/protocol test` |
| Access control | 12 assertions on RLS, share-link redemption and snapshot compare-and-swap, against real Postgres | `./supabase/tests/run.sh` |
| Test suites | **52 tests** across TypeScript, Python and SQL | `pnpm test` |

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
like an obvious optimisation — why store a delete for something you don't have —
and it silently loses the delete. A peer that loaded a snapshot after the
deletion, then received a stale broadcast of the element from a peer who hadn't
processed it yet, would resurrect the element permanently.
[`reconcile.ts`](packages/protocol/src/reconcile.ts)

**`rectFill` cannot separate a diamond from a rectangle.** A diamond's *minimal*
enclosing rectangle is edge-aligned, not axis-aligned, so area-over-rect measures
~0.75 rather than the textbook 0.5 and overlaps the rectangle case entirely.
Replaced with a rotation-invariant test on the quadrilateral's diagonals. That
plus switching score combination from a product to a weighted geometric mean took
recognition from 65% to 95.8%. [`recognize.ts`](packages/shapes/src/recognize.ts)

---

## Layout

```
apps/
  web/          Next.js app — canvas, collab hook, AI routes        → Vercel
  vision/       FastAPI + OpenCV — photo vectorisation, deep fit    → Render
packages/
  protocol/     Broadcast events, merge rules, writer election
  shapes/       Geometry recogniser and alignment engine
supabase/
  migrations/   Schema, RLS, Realtime authorization, storage
  tests/        Applies migrations to throwaway Postgres and asserts security
scripts/
  loadtest.ts   Realtime load harness
```

`packages/protocol` deliberately does not import Excalidraw: it is consumed by
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

In the Supabase dashboard, enable **Authentication → Sign In / Providers →
Anonymous sign-ins**. That is the one dashboard toggle that matters — it is the
entire onboarding path. Realtime private channels need no toggle; the migrations
install the `realtime.messages` policies that authorize them.

Step-by-step from nothing — including which dashboard toggles matter and a smoke
test that isolates each subsystem — is in [docs/SETUP.md](docs/SETUP.md).
Deployment reference, including the UptimeRobot keepalive that stops Render's
free instance sleeping through a 50-second cold start, is in
[docs/DEPLOY.md](docs/DEPLOY.md).
Design decisions and the reasoning behind them are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Notes on the stack

**Excalidraw, not tldraw** — tldraw's licence renders a watermark.

**Supabase Realtime, not a socket server** — one less service to run, and the
Realtime authorization policies mean channel access is enforced by the same RLS
that guards the tables. The cost is that there is no server-side hook, which is
what makes the peer-side convergence work necessary.

**Gemini returns an IR, not Excalidraw elements** — a scene needs `seed`,
`versionNonce`, fractional `index`, `boundElements` cross-references and arrow
binding focus/gap values to all agree. A language model produces something that
*looks* right and renders as a pile of unbound arrows. The model gets a small
vocabulary; a compiler does the bookkeeping.

**Layout is hand-written, not model-chosen** — a Sugiyama pass (break cycles,
rank, barycentre ordering, coordinate assignment). Asking for coordinates gets
overlaps, drift, and different results for identical requests.
