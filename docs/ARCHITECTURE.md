# Architecture

The organising constraint: **there is no application server.** The app is served
from Vercel's edge, sync runs over Supabase Realtime, and Realtime is a
WebSocket fan-out with no hook to run code in.

Everything below follows from that. Each section states the decision, then why
the obvious alternative doesn't work.

---

## 1. Where the rules live

With no server process, there are exactly two places a rule can be enforced for
everybody: **Postgres**, or **every client independently arriving at the same
answer**. Anything else is a suggestion.

So the split is:

| Concern | Where | Why not elsewhere |
|---|---|---|
| Access control | Postgres (RLS) | A client cannot be trusted to check its own permissions |
| Snapshot concurrency | Postgres (`SECURITY DEFINER` RPC) | Two writers can race; the compare-and-swap has to be atomic |
| Usage accounting | Postgres | Landing-page counters must not be client-reported |
| Convergence | Every client, identically | No server exists to be authoritative |
| Persistence scheduling | One elected client | No server exists to run a timer |
| Catch-up on join | One elected client | The persisted snapshot is already stale |

`board_snapshots` is granted `SELECT` only. Writes go exclusively through
`save_board_snapshot()`, which is what makes its version check impossible to
route around. A policy alone would still let a client `UPDATE` the row directly
and skip the concurrency logic.

---

## 2. Convergence

Excalidraw already stamps every element with a monotonic `version` and a random
`versionNonce`. That pair is enough for a merge that is **commutative,
associative and idempotent**, so every replica reaches the same scene regardless
of delivery order, without shipping a CRDT runtime alongside the canvas.

The order is total on `(version, versionNonce)`: higher version wins; on a tie the
lower nonce wins. Ties are common, since two peers dragging the same shape both
bump 41 to 42. Picking the lower nonce is arbitrary but identical everywhere,
which is the only property that matters.

### The tombstone trap

Deletes are tombstones, not removals, so they merge like any other edit. The
subtle part is what to do with a tombstone for an element you have never seen.

Discarding it is the intuitive choice. It also breaks convergence:

1. P1 deletes X and broadcasts the tombstone.
2. P3 joins, loads a snapshot that already excludes X, and receives the
   tombstone for an element it does not have, and discards it.
3. P2, who has not processed the delete yet, broadcasts X at version 5.
4. P3 has no record of the deletion, so it accepts X. **X is back, permanently.**

Retaining the tombstone fixes it. `pruneTombstones()` bounds the memory cost with
a TTL. This is asserted in
[`reconcile.test.ts`](../packages/protocol/src/reconcile.test.ts). It was found
by the randomised-order convergence test, not by reading the code.

### The other bug in the same function

The first implementation indexed into the output array, reserving a slot for each
newly seen id. When one batch contained two updates to the same new id, which is
exactly what a chunked delta or a large paste produces, the second write landed
past the end of the array. The result was a sparse array with a duplicated
element.

By value the scene still looked converged, which is why the property test now
asserts structural invariants (no duplicate ids, no holes) after *every* merge
step rather than only comparing end states. The fix was to key by id with a
separate order list.

---

## 3. Who persists the board

No server means no obvious place for the autosave timer. Rather than run a
dedicated process, the peers elect one of themselves from the presence map:

1. Viewers are ineligible (RLS would reject their write anyway).
2. Earliest `joinedAt` wins, since that peer most likely holds the fullest scene.
3. Ties break on `peerId`, lexicographically.

That is a pure function of presence state, so every peer computes the same answer
with no extra round trips.

Presence propagation is not instantaneous, so two peers can briefly both believe
they are the writer. That is survivable **by design** rather than by luck:
`save_board_snapshot()` takes the version the caller read as a precondition, so
the loser's write is rejected as stale and retried against the current version
instead of reverting the winner's save.

### An election is not a guarantee

The rule is a pure function of what peers say about themselves, and nothing
checks that the winner then does the job. Malice is the least likely way that
goes wrong. A writer in a background tab is the likely one: browsers throttle
timers there to roughly once a minute, slower than the 20 s ceiling the writer
depends on, so the tab someone left open in another window can end up
responsible for saving a board they are actively drawing on in this one.

So any peer that is editing will save the board itself if nobody has been seen
to save it for 45 s, well over twice the ceiling. It is gated on an edit rather
than on a timer, which is what makes it safe to leave on: a board nobody is
drawing on needs no save and never reaches the check. Taking over costs nothing
when it turns out to be unnecessary, because the write is an ordinary
compare-and-swap and the loser adopts the winner's version.

### Two timers, not one

The writer holds a debounce *and* a ceiling:

- The debounce (4 s) stops a continuous drag from issuing a write per frame.
- The ceiling (20 s) guarantees a save even if input never pauses.

A debounce alone can be starved indefinitely by steady input, which is what a
long uninterrupted sketch looks like.

---

## 4. Catch-up on join

A joiner loads the persisted snapshot from Postgres, which can be up to the
autosave interval behind live state. So on subscribe it broadcasts `hello` with a
fingerprint of what it loaded, and **only the elected writer answers** with
anything newer. Having every peer answer would send one full scene per peer.

---

## 5. Why viewers are handled differently

The Realtime insert policy is split by extension:

- `presence`: anyone who can read the board
- `broadcast`: editors only

A read-only collaborator could never *persist* elements (`save_board_snapshot`
checks `can_edit_board`), but without this split they could still inject them
into everyone else's live canvas until the next reload. So viewers publish their
cursor through presence state instead of the 20 Hz cursor broadcast. Presence is
heavier per update, and viewers are rare and their cursor does not need 20 Hz.

---

## 6. Stroke beautification: two paths

| | Client (`packages/shapes`) | Service (`apps/vision`) |
|---|---|---|
| Runs | In the browser, synchronously | On Render, on request |
| Latency | Same frame as the pen lifting | Network + ~50 ms |
| Method | Polyline geometry | Rasterise, fill, contour analysis |
| Handles | Clean single strokes | Overdrawn, self-crossing, multi-pass strokes |

The client path has to land in the frame the pen lifts. A shape that snaps 200 ms
later reads as the canvas fighting the user, so the network is not an option
there.

The service path earns its place by **filling closed strokes before analysis**.
That collapses a rectangle drawn in three overlapping passes, or one whose corners
overshoot and cross, into a single solid region whose contour is the shape the
user meant. A polyline recogniser sees one self-intersecting path and declines.

### What the accuracy work actually turned on

Two findings, both measured:

**`rectFill` cannot separate a diamond from a rectangle.** Area over min-area-rect
area is 1.0 for a rectangle and, per the textbook, 0.5 for a diamond. It measures
~0.75. The reason: a diamond's *minimal* enclosing rectangle is edge-aligned, not
axis-aligned, so the ratio depends on the diamond's aspect and overlaps the
rectangle case entirely. Replaced with a rotation-invariant test on the
quadrilateral's diagonals: perpendicular and mutually bisecting.

**Scores must combine as a weighted geometric mean, not a product.** Five factors
at a perfectly respectable 0.85 multiply out to 0.44, which put every shape under
threshold and made the recogniser refuse to fire at all. This was the difference
between 65% and 87%.

A corner-refinement pass, fusing the tremor artefacts RDP reports as spurious
vertices, took it from 87% to **95.8%**. The remaining misses are near-squares,
where "rectangle" and "diamond" are the same shape.

---

## 7. Photo → editable diagram

```
photo → deskew → adaptive threshold → thin → prune → graph → assemble → fit
```

Each stage exists because the previous approach failed on measured data.

**Deskew, not robustness.** A photo of a whiteboard is never square-on, and the
keystone makes every rectangle fit as a trapezoid. Correcting once via the board's
border contour is far more reliable than being robust to it downstream. The warp
is inset slightly, because the detected quad never lands exactly on the board edge
and the surviving rim reads as a long straight stroke down the side.

**Adaptive threshold, not global.** Whiteboards photograph with a strong
illumination gradient and glare hotspots. Any single threshold either loses
strokes in the shadowed corner or turns the glare into ink.

**Thin before tracing.** `findContours` on thresholded ink returns the *outline of
the marker stroke*. A rectangle comes back as two nested rings and neither one is
the rectangle. Thinning to the centreline is what makes the output editable.

**Prune the skeleton.** Zhang-Suen is one pixel wide but not topologically clean.
On a plain 360×220 ellipse it leaves **311 pixels of 930** with three
8-neighbours, all plainly mid-stroke. Any graph built on that sees two dozen
junctions that do not exist and the ellipse arrives in twenty pieces. Deleting
pixels that carry no connectivity takes it to zero.

The connectivity number is not the fix. It fails the other way: where a branch
leaves diagonally beside another, two branches merge into one ring run. A real T
in the test image measures degree 3 but connectivity 2, so the tracer walks
straight through it and chains every shape on the board into one polyline.

**Cluster junction pixels into junction nodes.** Thinning leaves a *clump* of
degree-3 pixels where strokes meet, with one- and two-pixel stubs between them.
Treating each as its own junction produces a swarm of micro-fragments, and then
any "two ends meeting must belong together" rule chains through a real T.
Dilating the junction mask before labelling collapses each clump to one node, and
only then is the branch count at a node meaningful.

**Assemble with one decision per node.** Two branches is a corner the thinning
split, so join outright. A corner is a 90 degree turn, and any continuity test
would reject the case being repaired. Three or more is a real junction, so join
only the straightest through-pair. That reunites a box's side across the
connector landing on it while leaving the connector its own element.

---

## 8. AI beautification

Gemini never returns Excalidraw elements.

A scene needs `seed`, `versionNonce`, fractional `index`, `boundElements`
cross-references and arrow binding `focus`/`gap` values to all agree. A language
model produces something that looks right and renders as a pile of unbound
arrows. They appear attached until the first time anything moves.

So the model gets a much smaller vocabulary (`LimnDiagram`: nodes, edges, labels,
grouping) under constrained decoding via `responseSchema`, and a deterministic
compiler turns that into a scene through `convertToExcalidrawElements`, the
skeleton API Excalidraw publishes for this, which handles all of the bookkeeping
including bindings.

The model does the part it is good at (reading intent out of a sketch) and none of
the part it is bad at.

### Same intent means same arrangement

In `preserve` mode, the default for cleaning up a sketch, each node keeps the
bounding box of whatever the user drew for it, identified by the `sourceIds` the
model reports. Only sizes and alignment change, via 1-D clustering that snaps
shared baselines, equalises near-equal sizes and evens gaps that are already
close to even.

That last qualifier matters: forcing uniform spacing on a deliberately clustered
layout destroys grouping the user meant to express.

### Choosing the model

Picked by measurement, not by version number. `scripts/bench-gemini.py` runs the
app's real prompts, schema and fixtures three times per model and scores the
three behaviours that matter: declining a drawing, accepting a flowchart, and
generating a diagram from text.

| model | correct | median latency | errors |
|---|---|---|---|
| gemini-3.6-flash | 9/9 | 8313 ms | none |
| gemini-3.1-flash-lite | 9/9 | 4932 ms | none |
| gemini-3.5-flash | 8/9 | 6419 ms | one 429 |
| gemini-3.7-flash | 4/9 | 7483 ms | five 503s |

Two things this caught that reasoning would not have. The newest model is not
the best one: 3.7 is so oversubscribed that most calls return 503. And the
alias `gemini-flash-latest` inherits exactly that problem, since it tracks
whatever is newest, so the models are pinned instead.

`GEMINI_MODEL_PRO` stays pointed at `gemini-pro-latest` even though Pro returns
429 on the free tier, because the client falls back to the base model on 429.
That costs one wasted round trip on a free key and upgrades for nothing on a
paid one. The panel reports which model actually answered.

### Layout is not the model's job

`layout.ts` is a compact Sugiyama pipeline: break cycles by reversing DFS back
edges, rank by longest path, order within ranks by barycentre, assign
coordinates. Asking the model for coordinates gets overlaps, drift out of
alignment, and different results for identical requests. Layout is a solved
deterministic problem and spending model capacity on it buys nothing while costing
reproducibility.

Cycles are only reversed for *positioning*. The edge is still drawn in its
original direction, so a cycle in the user's diagram still reads as a cycle.

---

## 9. Message pacing and framing

| | Interval | Reason |
|---|---|---|
| Scene deltas | 33 ms (~30 fps) | Indistinguishable from 60 while halving traffic |
| Cursors, editor | 50 ms (20 fps) | Indistinguishable from 60 at a third of the cost |
| Cursors, viewer | 250 ms (4 fps) | A viewer has no broadcast permission, so their cursor rides presence, and every presence update forces a full roster rebuild and re-render on every other peer |
| Client event ceiling | 40/s | Realtime's default of 10/s starves a 30 fps channel and silently drops the tail of a fast drag |

Only elements whose `version` differs from what was last transmitted are sent. On
a busy board that is the difference between shipping the whole scene 30×/s and
shipping the two shapes that moved.

That bookkeeping is committed only once a chunk is acknowledged. Marking an
element as sent at the moment it was collected loses it outright when the send
then fails: the channel drops, the retry recomputes the delta, and every element
it had already crossed off is now considered current and never goes out again.
The peer on the other side is missing shapes that no later edit will resend, and
nothing anywhere reports an error. So the delta is computed without mutating,
and the versions are recorded per chunk after the publish returns `ok`.

Frames above the broadcast size ceiling are split and reassembled by `gid`.
Realtime drops oversized frames silently from the sender's point of view, so the
update never arrives, and an AI recompose or a large paste easily exceeds it. A
single element larger than the budget still gets its own frame. Splitting inside
an element would break the atomicity the merge depends on.

---

## 10. Why every inbound frame is validated

Realtime authorizes a peer onto a topic and then fans out whatever JSON that peer
sends. There is no server to sanitise anything. So every broadcast payload is
parsed with zod at the receive boundary before it goes near scene state. A
compromised or merely out-of-date client must not be able to corrupt a board for
everyone else.

`decodeEvent` returns a discriminated result rather than throwing: a malformed
frame is a routine event on a public channel, not an exceptional one, and the hot
path should not pay for stack capture.
