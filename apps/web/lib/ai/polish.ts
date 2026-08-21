import {
  bbox,
  dist,
  fitLine,
  pathLength,
  recognizeStroke,
  rotate,
  type Box,
  type Point,
} from "@limn/shapes";
import type { SyncElement } from "@limn/protocol";
import type { PolishGroup, PolishOp } from "./schema";

/**
 * Tidies a drawing in place, from groups the model named over ids that already
 * exist on the canvas.
 *
 * The diagram path reads a structure out of a sketch and rebuilds it, which only
 * works when there is a structure to restate. A house has none, so that path had
 * nothing to say about it and declining was the only honest answer left. This is
 * the other half: the model says "these five ids are the house, square it up and
 * share its baselines" and every coordinate below is derived from what the user
 * already drew. The model is never asked for one, same as ./plan.
 *
 * Pure, and deliberately free of any @excalidraw/excalidraw import: that package
 * touches `window` at module load, so importing it here would make this file
 * untestable. ./plan is split from ./compile for the same reason.
 *
 * The one rule that separates this from the diagram path: nothing is ever
 * deleted or tombstoned. A rebuild replaces the sketch and can afford to, having
 * understood it. Polish has not understood anything, it has only been told what
 * belongs together, so a polish that loses a stroke is worse than no polish at
 * all. Element count out equals element count in, always.
 */

/** Whatever we are part-way through editing. Same opaque shape as SyncElement. */
type Draft = Record<string, unknown> & { id: string };

interface Member {
  id: string;
  draft: Draft;
  /** Scene order, so every tie-break and sort is stable rather than model-order. */
  order: number;
  /**
   * False for an arrow bound at either end. Excalidraw re-routes a bound arrow
   * from its endpoints when they move, so translating it ourselves applies the
   * move twice and the arrow ends up detached from both shapes.
   */
  movable: boolean;
}

export interface PolishResult {
  /** The FULL scene, same length and same order as the input. */
  elements: SyncElement[];
  /** Ids actually modified, for the caller to report and to sync. */
  changed: string[];
  /** Groups that produced a change, which is not the same as groups received. */
  groups: number;
}

/**
 * Applied in this order whatever order the model listed them in.
 *
 * Sizes have to settle before positions: equalising a width moves the left edge,
 * so align-left running first would leave the group unaligned. Distribute runs
 * last because it reads the final sizes and the final span.
 */
const OP_ORDER = [
  "match-style",
  "regularize",
  "straighten",
  "equalize-size",
  "align-left",
  "align-right",
  "align-center-x",
  "align-top",
  "align-bottom",
  "align-center-y",
  "distribute-x",
  "distribute-y",
] as const satisfies readonly PolishOp[];

/** Aspect ratios this close to 1 read as "meant to be square", so regularize squares them. */
const SQUARE_TOLERANCE = 0.18;

/** recognize.ts's snap tolerance, so a slip is judged the same here as at draw time. */
const ANGLE_SNAP = (8 * Math.PI) / 180;

/**
 * Ends closer together than this share of the stroke's own length mean it came
 * back to where it started. Same ratio recognize.ts calls a stroke closed by.
 */
const CLOSED_GAP_RATIO = 0.22;

/**
 * Mean perpendicular error over the stroke's diagonal, past which the bend is
 * the point of the stroke. A full circle scores about 0.32 here, a hand-drawn
 * line with a few pixels of wobble under 0.05.
 */
const STRAIGHT_RESIDUAL = 0.12;

/**
 * Below this the recogniser is guessing. Rewriting a deliberate squiggle into a
 * circle is far worse than leaving a rough circle alone, which is the same call
 * packages/shapes makes at its own threshold.
 */
const REGULARIZE_CONFIDENCE = 0.7;

/** Samples around an idealised ellipse. Enough that it reads as smooth at any zoom. */
const ELLIPSE_SAMPLES = 64;

/** Shapes whose box is the whole shape, so writing width and height regularises them. */
const BOXED = new Set(["rectangle", "ellipse", "diamond"]);

/** Unified by match-style. Exactly these three; fills and fonts are not style noise. */
const STYLE_KEYS = ["strokeColor", "strokeWidth", "roughness"] as const;

/**
 * Every coordinate we write lands on whole pixels.
 *
 * Sub-pixel results survive into the next run's input, so a group polished twice
 * drifts by a fraction each time and never settles. The align engine in
 * packages/shapes rounds harder still, to a 4px lattice, for the same reason.
 */
const round = (v: number): number => Math.round(v);

const nonce = (): number => Math.floor(Math.random() * 2 ** 31);

function boxOf(el: Draft): Box | null {
  const x = Number(el.x);
  const y = Number(el.y);
  const width = Number(el.width ?? 0);
  const height = Number(el.height ?? 0);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return { x, y, width, height };
}

/** Element-local stroke points, or null for anything that is not a stroke. */
function pointsOf(el: Draft): Point[] | null {
  const raw = el.points;
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const points: Point[] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2) return null;
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    points.push([x, y]);
  }
  return points;
}

/** Text elements bound into this container, which move when it moves. */
function boundTextIds(el: Draft): string[] {
  const bound = el.boundElements;
  if (!Array.isArray(bound)) return [];
  const ids: string[] = [];
  for (const entry of bound) {
    if (!entry || typeof entry !== "object") continue;
    const { id, type } = entry as { id?: unknown; type?: unknown };
    if (type === "text" && typeof id === "string") ids.push(id);
  }
  return ids;
}

function isBoundArrow(el: Draft): boolean {
  return el.type === "arrow" && (el.startBinding != null || el.endBinding != null);
}

/**
 * Text is excluded from anything that writes width or height. An Excalidraw text
 * element's box is measured from its font size and its wrapping, so overwriting
 * it does not scale the glyphs, it just makes the box disagree with the text
 * until the next reflow re-measures it and throws the change away.
 */
function isResizable(el: Draft): boolean {
  return el.type !== "text";
}

/** Ignores version bookkeeping, which we set ourselves once at the end. */
function differs(before: SyncElement, after: Draft): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (key === "version" || key === "versionNonce" || key === "updated") continue;
    const a = (before as Record<string, unknown>)[key];
    const b = after[key];
    if (a === b) continue;
    if (JSON.stringify(a) !== JSON.stringify(b)) return true;
  }
  return false;
}

export function polishSketch(
  elements: readonly SyncElement[],
  groups: readonly PolishGroup[],
): PolishResult {
  const originals = new Map<string, SyncElement>();
  const order = new Map<string, number>();
  elements.forEach((el, index) => {
    originals.set(el.id, el);
    order.set(el.id, index);
  });

  const drafts = new Map<string, Draft>();
  /** Copy on write, so an element nobody touched stays identical by reference. */
  const draftOf = (id: string): Draft | null => {
    const source = originals.get(id);
    if (!source) return null;
    let draft = drafts.get(id);
    if (!draft) {
      draft = { ...source } as Draft;
      drafts.set(id, draft);
    }
    return draft;
  };

  /**
   * Moves an element and carries its bound text along by the same delta.
   *
   * The text is never handled as a group member in its own right: it is a child
   * of the container's geometry, and aligning it separately tears the label out
   * of the box it labels.
   */
  const moveTo = (draft: Draft, x: number, y: number): void => {
    const fromX = Number(draft.x);
    const fromY = Number(draft.y);
    if (!Number.isFinite(fromX) || !Number.isFinite(fromY)) return;
    const nextX = round(x);
    const nextY = round(y);
    const dx = nextX - fromX;
    const dy = nextY - fromY;
    if (dx === 0 && dy === 0) return;
    draft.x = nextX;
    draft.y = nextY;
    for (const id of boundTextIds(draft)) {
      const text = draftOf(id);
      if (!text) continue;
      const tx = Number(text.x);
      const ty = Number(text.y);
      if (!Number.isFinite(tx) || !Number.isFinite(ty)) continue;
      text.x = round(tx + dx);
      text.y = round(ty + dy);
    }
  };

  /**
   * Replaces a stroke's points, re-anchoring so points[0] is the origin.
   *
   * Excalidraw treats x,y as the position of the first point and the rest as
   * offsets from it, so a points array that does not start at [0, 0] renders the
   * stroke somewhere other than where its own box says it is.
   */
  const setPoints = (draft: Draft, points: readonly Point[]): void => {
    const first = points[0];
    if (!first || points.length < 2) return;
    const local = points.map((p) => [round(p[0] - first[0]), round(p[1] - first[1])] as Point);
    const from = boxOf(draft);
    if (from) moveTo(draft, from.x + first[0], from.y + first[1]);
    draft.points = local.map((p) => [p[0], p[1]]);
    const span = bbox(local);
    draft.width = round(span.width);
    draft.height = round(span.height);
    // freedraw carries one pressure per point, so a rewritten stroke keeping the
    // old array renders with the taper of a stroke that no longer exists.
    if (draft.type === "freedraw") {
      draft.pressures = [];
      draft.simulatePressure = true;
    }
    // A committed point that is no longer in `points` leaves the line editor
    // resuming the stroke from a coordinate that was just discarded.
    if ("lastCommittedPoint" in draft) draft.lastCommittedPoint = null;
  };

  /** Resizes about the centre, so a member does not appear to drift as it grows. */
  const resize = (draft: Draft, width: number, height: number): void => {
    const box = boxOf(draft);
    if (!box || !isResizable(draft)) return;
    const w = Math.max(round(width), 1);
    const h = Math.max(round(height), 1);

    const points = pointsOf(draft);
    if (points) {
      // A zero-extent axis (a perfectly vertical line has width 0) has no scale
      // factor to compute, so that axis is left as drawn rather than divided by.
      const span = bbox(points);
      const sx = span.width > 0.5 ? w / span.width : 1;
      const sy = span.height > 0.5 ? h / span.height : 1;
      const cx = span.x + span.width / 2;
      const cy = span.y + span.height / 2;
      setPoints(
        draft,
        points.map((p) => [(p[0] - cx) * sx + cx, (p[1] - cy) * sy + cy] as Point),
      );
      return;
    }

    draft.width = w;
    draft.height = h;
    moveTo(draft, box.x + (box.width - w) / 2, box.y + (box.height - h) / 2);
  };

  let changedGroups = 0;
  /** An id belongs to the first group that claims it; later groups cannot re-move it. */
  const claimed = new Set<string>();

  for (const group of groups) {
    const members: Member[] = [];
    /** Ids to inspect afterwards to decide whether this group did anything. */
    const touched = new Set<string>();

    for (const id of group.ids) {
      // Every id here comes from the model, so all three of these are things it
      // routinely gets wrong: an id it invented, one it read off an element the
      // user has since deleted, and the same id filed under two groups.
      if (claimed.has(id)) continue;
      const source = originals.get(id);
      if (!source || source.isDeleted === true) continue;
      // The author pinned this one deliberately; a tidy-up is not a reason to
      // override that.
      if (source.locked === true) continue;
      // Bound text moves with its container and nowhere else, see moveTo.
      if (typeof source.containerId === "string") continue;

      const draft = draftOf(id);
      if (!draft) continue;
      claimed.add(id);
      members.push({
        id,
        draft,
        order: order.get(id) ?? 0,
        movable: !isBoundArrow(draft),
      });
      touched.add(id);
      for (const textId of boundTextIds(draft)) touched.add(textId);
    }

    if (members.length === 0) continue;
    members.sort((a, b) => a.order - b.order);

    const ops = new Set<PolishOp>(group.ops);
    for (const op of OP_ORDER) {
      if (!ops.has(op)) continue;
      apply(op, members, { moveTo, setPoints, resize });
    }

    for (const id of touched) {
      const before = originals.get(id);
      const after = drafts.get(id);
      if (before && after && differs(before, after)) {
        changedGroups++;
        break;
      }
    }
  }

  const now = Date.now();
  const changed: string[] = [];
  const out = elements.map((el) => {
    const draft = drafts.get(el.id);
    if (!draft || !differs(el, draft)) return el;
    changed.push(el.id);
    // Without a higher version and a fresh nonce the sync layer treats this as
    // the element it already has: collectDelta diffs on version, and reconcile
    // breaks ties on the nonce. The edit would look right locally and reach
    // nobody else.
    return {
      ...draft,
      version: (Number(el.version) || 0) + 1,
      versionNonce: nonce(),
      updated: now,
    } as SyncElement;
  });

  return { elements: out, changed, groups: changedGroups };
}

interface Ops {
  moveTo: (draft: Draft, x: number, y: number) => void;
  setPoints: (draft: Draft, points: readonly Point[]) => void;
  resize: (draft: Draft, width: number, height: number) => void;
}

interface Placed {
  member: Member;
  box: Box;
}

/** Members that can be moved and have a box to move, in scene order. */
function placed(members: readonly Member[]): Placed[] {
  const out: Placed[] = [];
  for (const member of members) {
    if (!member.movable) continue;
    const box = boxOf(member.draft);
    if (box) out.push({ member, box });
  }
  return out;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function apply(op: PolishOp, members: readonly Member[], ops: Ops): void {
  switch (op) {
    case "match-style":
      matchStyle(members);
      return;
    case "regularize":
      for (const member of members) regularize(member, ops);
      return;
    case "straighten":
      for (const member of members) straighten(member, ops);
      return;
    case "equalize-size":
      equalizeSize(members, ops);
      return;
    case "distribute-x":
      distribute(members, "x", ops);
      return;
    case "distribute-y":
      distribute(members, "y", ops);
      return;
    default:
      align(op, members, ops);
  }
}

/**
 * Flushes members against a shared edge or centre.
 *
 * packages/shapes already has alignBoxes and it is the right tool for the
 * diagram path, but not here: it clusters first, deciding for itself which boxes
 * belong on a shared baseline, and the group has already answered that question.
 * It also refuses to even out gaps that are not nearly even already, which is
 * exactly the case an explicit distribute-x is asking about.
 */
function align(op: PolishOp, members: readonly Member[], ops: Ops): void {
  const boxes = placed(members);
  // One element is already aligned with itself, and there is no second edge to
  // agree with, so the op has no meaning rather than a trivial answer.
  if (boxes.length < 2) return;

  const left = Math.min(...boxes.map((b) => b.box.x));
  const right = Math.max(...boxes.map((b) => b.box.x + b.box.width));
  const top = Math.min(...boxes.map((b) => b.box.y));
  const bottom = Math.max(...boxes.map((b) => b.box.y + b.box.height));

  for (const { member, box } of boxes) {
    switch (op) {
      case "align-left":
        ops.moveTo(member.draft, left, box.y);
        break;
      case "align-right":
        ops.moveTo(member.draft, right - box.width, box.y);
        break;
      case "align-center-x":
        // The group's bounding centre, not the mean of the members' centres: the
        // mean shifts toward whichever side happens to hold more elements.
        ops.moveTo(member.draft, (left + right) / 2 - box.width / 2, box.y);
        break;
      case "align-top":
        ops.moveTo(member.draft, box.x, top);
        break;
      case "align-bottom":
        ops.moveTo(member.draft, box.x, bottom - box.height);
        break;
      case "align-center-y":
        ops.moveTo(member.draft, box.x, (top + bottom) / 2 - box.height / 2);
        break;
      default:
        return;
    }
  }
}

/** Evens the gaps between members, keeping the outermost two where they are. */
function distribute(members: readonly Member[], axis: "x" | "y", ops: Ops): void {
  const sizeKey = axis === "x" ? "width" : "height";
  const boxes = placed(members).sort((a, b) => a.box[axis] - b.box[axis]);
  // With two members there is no interior gap to even out, and the ends never
  // move, so anything under three is a no-op by definition.
  if (boxes.length < 3) return;

  const first = boxes[0];
  const last = boxes[boxes.length - 1];
  if (!first || !last) return;

  const span = last.box[axis] + last.box[sizeKey] - first.box[axis];
  const total = boxes.reduce((sum, b) => sum + b.box[sizeKey], 0);
  const gap = (span - total) / (boxes.length - 1);
  // A negative gap means the members overlap. Spreading them to an even negative
  // overlap rearranges a deliberate pile, so leave it as drawn.
  if (!Number.isFinite(gap) || gap < 0) return;

  let cursor = first.box[axis] + first.box[sizeKey];
  for (let i = 1; i < boxes.length - 1; i++) {
    const entry = boxes[i];
    if (!entry) continue;
    const position = cursor + gap;
    ops.moveTo(
      entry.member.draft,
      axis === "x" ? position : entry.box.x,
      axis === "x" ? entry.box.y : position,
    );
    cursor = position + entry.box[sizeKey];
  }
}

/** One bounding size for every member, taken from the middle of what they already are. */
function equalizeSize(members: readonly Member[], ops: Ops): void {
  const boxes = placed(members).filter(({ member }) => isResizable(member.draft));
  if (boxes.length < 2) return;

  // Median rather than mean, so one oversized member does not inflate the whole
  // group. The align engine sizes its tolerance off a median for the same reason.
  const width = median(boxes.map((b) => b.box.width));
  const height = median(boxes.map((b) => b.box.height));
  // A row of vertical strokes has a median width of 0, and there is nothing on
  // that axis to agree on. Requiring both axes meant the whole op quietly did
  // nothing for them, so each axis is decided on its own and a flat one keeps
  // whatever each member already had.
  if (width < 1 && height < 1) return;

  for (const { member, box } of boxes) {
    ops.resize(member.draft, width < 1 ? box.width : width, height < 1 ? box.height : height);
  }
}

/** A wobbly stroke becomes the straight segment it was aiming at. */
function straighten(member: Member, ops: Ops): void {
  if (!member.movable) return;
  const points = pointsOf(member.draft);
  if (!points) return;

  const from = points[0];
  const to = points[points.length - 1];
  if (!from || !to) return;

  // An op applies to every member, and the group that holds the roof lines also
  // holds the round window. Fitting that window to a line leaves a 2-point
  // segment where the window was, which is exactly the destruction this file
  // exists to avoid, so a stroke has to look like a segment before it is turned
  // into one. Two ways it can fail to: it comes back to where it started, or it
  // sits too far off its own best fit for the bend to be an accident.
  const span = pathLength(points);
  if (span <= 0 || dist(from, to) / span < CLOSED_GAP_RATIO) return;

  const extent = bbox(points);
  const diagonal = Math.hypot(extent.width, extent.height);
  if (diagonal <= 0) return;

  // Total least squares, not first-point-to-last: a stroke that overshoots at
  // one end would otherwise tilt the whole segment to chase the overshoot.
  const line = fitLine(points);
  if (line.residual / diagonal > STRAIGHT_RESIDUAL) return;

  const forward = dist(from, line.start) <= dist(from, line.end);
  const start = forward ? line.start : line.end;
  const end = forward ? line.end : line.start;
  // Direction is not cosmetic on an arrow: reversing it puts the head on the
  // wrong end of what the author drew.
  if (dist(start, end) < 1) return;

  ops.setPoints(member.draft, [start, end]);
}

/** A near-circle becomes a circle, a near-square squares up. */
function regularize(member: Member, ops: Ops): void {
  if (!member.movable || !isResizable(member.draft)) return;
  const draft = member.draft;

  const points = pointsOf(draft);
  if (points) {
    // A hand-drawn shape is still freedraw points, so squaring its box alone
    // would leave the wobble stretched rather than removed. The recogniser in
    // packages/shapes already knows what the stroke was aiming at, and it
    // reports a confidence precisely so a caller can decline to act on a guess.
    // Only the closed kinds are handled here; an open stroke is straighten's job.
    const shape = recognizeStroke(points);
    if (shape.confidence < REGULARIZE_CONFIDENCE) return;
    if (!BOXED.has(shape.kind)) return;
    const outline = idealOutline(shape.kind, squared(shape.box), shape.angle);
    if (outline) ops.setPoints(draft, outline);
    return;
  }

  if (!BOXED.has(String(draft.type))) return;
  const box = boxOf(draft);
  if (!box) return;

  const target = squared(box);
  if (target.width !== box.width || target.height !== box.height) {
    ops.resize(draft, target.width, target.height);
  }

  // A box drawn three degrees off true is a slip, not a design. Quarter turns
  // only, though recognize.ts snaps to eighths: a shape sitting at 45 degrees is
  // there because the author put it there, and flattening that is a rewrite.
  const angle = Number(draft.angle);
  if (Number.isFinite(angle) && angle !== 0) {
    const quarter = Math.PI / 2;
    const nearest = Math.round(angle / quarter) * quarter;
    if (Math.abs(angle - nearest) <= ANGLE_SNAP) {
      // Modulo a full turn, or a shape sitting just under 2π gets written back
      // as 2π, which is the same rotation stored in a form nothing else uses.
      draft.angle = nearest % (Math.PI * 2);
    }
  }
}

/** Equalises a box's sides when they are already close, otherwise returns it unchanged. */
function squared(box: Box): Box {
  const longest = Math.max(box.width, box.height);
  const shortest = Math.min(box.width, box.height);
  if (longest <= 0 || (longest - shortest) / longest > SQUARE_TOLERANCE) return box;
  const side = round((box.width + box.height) / 2);
  return {
    x: box.x + (box.width - side) / 2,
    y: box.y + (box.height - side) / 2,
    width: side,
    height: side,
  };
}

/**
 * The path a clean version of this shape traces, in the stroke's own frame.
 *
 * Emitted as points on the existing element rather than as a new rectangle or
 * ellipse element. Swapping the type would mean synthesising a fresh Excalidraw
 * element (seed, fractional index, roundness, bindings), which is exactly the
 * bookkeeping ./compile owns and cannot be reproduced here without importing the
 * SDK. Keeping the element and cleaning its path also keeps the promise that
 * nothing is destroyed: undo returns the original stroke, not a hole.
 */
function idealOutline(kind: string, box: Box, angle: number): Point[] | null {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const rx = box.width / 2;
  const ry = box.height / 2;
  if (rx <= 0 || ry <= 0) return null;

  const spin = (p: Point): Point => (angle ? rotate(p, angle, [cx, cy]) : p);
  const ring: Point[] = [];

  if (kind === "ellipse") {
    for (let i = 0; i < ELLIPSE_SAMPLES; i++) {
      const t = (i / ELLIPSE_SAMPLES) * Math.PI * 2;
      ring.push(spin([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]));
    }
  } else if (kind === "rectangle") {
    ring.push(
      spin([cx - rx, cy - ry]),
      spin([cx + rx, cy - ry]),
      spin([cx + rx, cy + ry]),
      spin([cx - rx, cy + ry]),
    );
  } else if (kind === "diamond") {
    // Excalidraw inscribes a diamond in its box, so the vertices are the edge
    // midpoints. Same convention recognize.ts reports the box in.
    ring.push(spin([cx, cy - ry]), spin([cx + rx, cy]), spin([cx, cy + ry]), spin([cx - rx, cy]));
  } else {
    return null;
  }

  // The stroke was closed, so the path has to come back to where it started or
  // the shape renders with a gap at the seam.
  const first = ring[0];
  if (first) ring.push(first);
  return ring;
}

/** Unifies stroke weight, roughness and colour across the group. */
function matchStyle(members: readonly Member[]): void {
  for (const key of STYLE_KEYS) {
    const counts = new Map<string, { value: unknown; count: number }>();
    for (const member of members) {
      const value = member.draft[key];
      if (value === undefined || value === null) continue;
      const seen = counts.get(String(value));
      if (seen) seen.count++;
      else counts.set(String(value), { value, count: 1 });
    }

    // Majority wins, and members are in scene order, so a tie goes to whichever
    // was drawn first rather than to whichever the model happened to list first.
    // A group is usually one style with a stray, and the stray should not decide.
    let winner: { value: unknown; count: number } | null = null;
    for (const entry of counts.values()) {
      if (!winner || entry.count > winner.count) winner = entry;
    }
    if (!winner) continue;

    for (const member of members) {
      // Only where the property already exists. Adding strokeWidth to an element
      // type that never carried one invents state Excalidraw did not ask for.
      if (member.draft[key] === undefined || member.draft[key] === null) continue;
      member.draft[key] = winner.value;
    }
  }
}
