import {
  bbox,
  dist,
  fitLine,
  pathLength,
  recognizeStroke,
  rotate,
  type Box,
  type LineFit,
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

/** Anything carrying Excalidraw's geometry fields. A SyncElement or a Draft. */
type Geometric = Record<string, unknown>;

/** Whatever we are part-way through editing. Same opaque shape as SyncElement. */
type Draft = Geometric & { id: string };

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
 * Mean perpendicular error over the stroke's diagonal, under which the stroke is
 * near enough straight whatever shape the error takes.
 *
 * This sat at 0.12 for a while, on the grounds that a full circle scores about
 * 0.32. A circle never reaches this check, CLOSED_GAP_RATIO turns it away first,
 * so the number was calibrated against a case the guard has never once seen.
 * What does reach it is an OPEN arc, and those score nowhere near as high.
 * Measured on real arcs of 186px chord: 30 degrees scores 0.018, 60 scores
 * 0.036, 90 scores 0.055, and 137, an unmistakable rainbow with a 63px sagitta,
 * only 0.089. Every one of them came back as two points. Sitting between the 30
 * and the 60 leaves a lazy line straightenable and puts a real bend above it.
 */
const STRAIGHT_RESIDUAL = 0.035;

/**
 * Past STRAIGHT_RESIDUAL the shape of the error decides, because the size of it
 * on its own is scale-blind: a 40px stroke with 4px of shake in it scores about
 * the same as a wide gentle arch. A bow leaves its own best fit, runs to one
 * side, and comes back, so the side it sits on changes exactly twice. Wobble
 * crosses over and back again and again. More changes than this is wobble.
 */
const BOW_SIDE_CHANGES = 2;

/**
 * Offsets under this share of the widest one count as sitting on the line rather
 * than either side of it. Without the dead band the jitter where a shakily drawn
 * bow crosses its own fit counts as several changes of side, and the bow reads
 * as wobble.
 */
const SIDE_DEADBAND = 0.2;

/**
 * Past this nothing is straightened whatever shape the error takes.
 *
 * The side test above waves wobble through however deep it gets, because deep
 * wobble still alternates sides, and a stroke that strays an eighth of its own
 * length off the line it is meant to be has stopped being a shaky line and
 * become a scribble. The mean error is roughly the depth of the teeth over the
 * run, so this catches a zigzag once its teeth pass about 12% of its length.
 */
const WOBBLE_RESIDUAL = 0.12;

/**
 * Below this the recogniser is guessing. Rewriting a deliberate squiggle into a
 * circle is far worse than leaving a rough circle alone, which is the same call
 * packages/shapes makes at its own threshold.
 */
const REGULARIZE_CONFIDENCE = 0.7;

/**
 * Below this ratio of short side to long side an element is a line, not a box,
 * and its short axis is thickness rather than a dimension anyone chose.
 */
const LINE_ASPECT = 0.15;

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

function boxOf(el: Geometric): Box | null {
  const x = Number(el.x);
  const y = Number(el.y);
  const width = Number(el.width ?? 0);
  const height = Number(el.height ?? 0);
  if (![x, y, width, height].every(Number.isFinite)) return null;

  /**
   * For a stroke, x and y are the anchor of points[0], not the corner of the
   * bounding box, and the offsets may be negative.
   *
   * A stroke drawn right to left has its anchor at the RIGHT end, so its ink
   * runs from x - width to x. Reading x as the corner puts it a full width away
   * from where it is, and alignment then moves it to match a box that was never
   * there: the one stroke someone happened to draw backwards flies off on its
   * own while the rest line up.
   *
   * Rectangles and ellipses genuinely do use x,y as the corner, and they have no
   * points, so they fall through unchanged.
   */
  const points = pointsOf(el);
  if (!points) return { x, y, width, height };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of points) {
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  return { x: x + minX, y: y + minY, width: maxX - minX, height: maxY - minY };
}

/**
 * What the element actually covers on the canvas, rotation included.
 *
 * x, y, width and height describe the element before it was turned, and
 * Excalidraw turns it about the centre of that box. So for anything tilted they
 * are not the edges anyone can see: a 200 by 40 bar at 45 degrees reads as 200
 * wide and 40 tall while covering a 170 square. Aligning to the untilted numbers
 * put that bar's visible top 65px above the edge everything else shared, which
 * is not a subtle miss on a screen someone is filming.
 *
 * Not exotic either: Snap writes an angle onto any rectangle or ellipse more
 * than 8 degrees off axis, photo trace does the same, and regularize below
 * deliberately leaves a 45 degree shape at 45 degrees.
 *
 * Exported because BoardCanvas has to describe these same boxes to Gemini before
 * we edit them here, and a second copy of this over there drifts from this one.
 */
export function visualBox(el: Geometric): Box | null {
  const box = boxOf(el);
  if (!box) return null;

  const angle = Number(el.angle);
  if (!Number.isFinite(angle) || angle === 0) return box;

  // Rotation moves the edges and leaves the middle alone, so everything below is
  // measured out from this one point.
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  /**
   * A stroke is its ink, not the box drawn round it. Turning the box instead
   * claims the corners the ink never reached, and a diagonal stroke is nearly
   * all corner: a 200px line at 45 degrees would report a 141px square when it
   * covers a line. So turn the points and measure those.
   */
  const points = pointsOf(el);
  if (points) {
    const x = Number(el.x);
    const y = Number(el.y);
    return bbox(points.map((p) => rotate([x + p[0], y + p[1]], angle, [cx, cy])));
  }

  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  const w = box.width / 2;
  const h = box.height / 2;

  /**
   * Three shapes reach their widest point in three different places, which is
   * why Excalidraw's own bounds carry three formulas rather than one.
   *
   * A rectangle is widest at a corner, so both turned sides add up. An ellipse
   * has no corner and is widest where its tangent stands vertical, which is a
   * hypotenuse and always the smaller number. A diamond's vertices are the
   * midpoints of its box's edges, so exactly one of them is the widest point and
   * there is nothing to add to it.
   *
   * Measuring all three as rectangles read a 200 by 40 ellipse at 45 degrees as
   * 13px wider on every side than it draws, and a misplaced edge is the one
   * thing this function exists to prevent.
   */
  let halfW: number;
  let halfH: number;
  if (el.type === "ellipse") {
    halfW = Math.hypot(w * cos, h * sin);
    halfH = Math.hypot(h * cos, w * sin);
  } else if (el.type === "diamond") {
    halfW = Math.max(w * cos, h * sin);
    halfH = Math.max(h * cos, w * sin);
  } else {
    halfW = w * cos + h * sin;
    halfH = w * sin + h * cos;
  }
  return { x: cx - halfW, y: cy - halfH, width: halfW * 2, height: halfH * 2 };
}

/** Element-local stroke points, or null for anything that is not a stroke. */
function pointsOf(el: Geometric): Point[] | null {
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
  const moveTo = (draft: Draft, x: number, y: number, carryText = true): void => {
    const fromX = Number(draft.x);
    const fromY = Number(draft.y);
    if (!Number.isFinite(fromX) || !Number.isFinite(fromY)) return;

    // x and y name where the BOX should end up, not where the anchor should.
    // Those differ for a stroke, see boxOf, and every caller here is reasoning
    // about visible edges. Moving by the delta keeps the two in step without
    // asking any caller to know the difference.
    const box = boxOf(draft);
    if (!box) return;
    const dx = round(x) - box.x;
    const dy = round(y) - box.y;
    if (dx === 0 && dy === 0) return;
    draft.x = round(fromX + dx);
    draft.y = round(fromY + dy);
    // A resize about the centre translates the box to keep that centre still, so
    // the container moves but the middle of it does not, and the label sitting in
    // that middle must not move either. Carrying it there slid the label of a
    // shrunk box halfway out through its own edge.
    if (!carryText) return;
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
  const setPoints = (draft: Draft, points: readonly Point[], carryText = true): void => {
    const first = points[0];
    if (!first || points.length < 2) return;
    const local = points.map((p) => [round(p[0] - first[0]), round(p[1] - first[1])] as Point);
    const from = boxOf(draft);
    if (from) moveTo(draft, from.x + first[0], from.y + first[1], carryText);
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
      // Scaled about the centre, so the centre is where it was and any label
      // anchored there stays put. Hence carryText false, same as below.
      setPoints(
        draft,
        points.map((p) => [(p[0] - cx) * sx + cx, (p[1] - cy) * sy + cy] as Point),
        false,
      );
      return;
    }

    draft.width = w;
    draft.height = h;
    moveTo(draft, box.x + (box.width - w) / 2, box.y + (box.height - h) / 2, false);
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

/**
 * No carryText here on purpose, though moveTo and setPoints both take one.
 *
 * Leaving a bound label behind is only ever right for a move that keeps the
 * centre still, and resize is the only such move. Every op below moves an
 * element somewhere else, where the label has to follow or it is torn out of the
 * box it names, so none of them are given the flag that would let them drop it.
 */
interface Ops {
  moveTo: (draft: Draft, x: number, y: number) => void;
  setPoints: (draft: Draft, points: readonly Point[]) => void;
  resize: (draft: Draft, width: number, height: number) => void;
}

interface Placed {
  member: Member;
  /** The edges anyone can see, rotation included. What a shared edge is measured on. */
  box: Box;
  /**
   * The untilted box: the frame moveTo and resize write in, and the size an
   * element has in its own right.
   */
  raw: Box;
}

/** Members that can be moved and have a box to move, in scene order. */
function placed(members: readonly Member[]): Placed[] {
  const out: Placed[] = [];
  for (const member of members) {
    if (!member.movable) continue;
    const raw = boxOf(member.draft);
    const box = visualBox(member.draft);
    if (raw && box) out.push({ member, box, raw });
  }
  return out;
}

/**
 * Moves a member so its VISIBLE box lands at x, y.
 *
 * moveTo writes the untilted frame, and the two boxes share a centre, so the
 * delta that puts one edge where we want it is the same delta for both. Every
 * caller here is reasoning about edges on screen, so none of them should have to
 * know which frame they are in.
 */
function place(ops: Ops, entry: Placed, x: number, y: number): void {
  ops.moveTo(entry.member.draft, entry.raw.x + (x - entry.box.x), entry.raw.y + (y - entry.box.y));
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

  for (const entry of boxes) {
    const box = entry.box;
    switch (op) {
      case "align-left":
        place(ops, entry, left, box.y);
        break;
      case "align-right":
        place(ops, entry, right - box.width, box.y);
        break;
      case "align-center-x":
        // The group's bounding centre, not the mean of the members' centres: the
        // mean shifts toward whichever side happens to hold more elements.
        place(ops, entry, (left + right) / 2 - box.width / 2, box.y);
        break;
      case "align-top":
        place(ops, entry, box.x, top);
        break;
      case "align-bottom":
        place(ops, entry, box.x, bottom - box.height);
        break;
      case "align-center-y":
        place(ops, entry, box.x, (top + bottom) / 2 - box.height / 2);
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
    place(
      ops,
      entry,
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

  /**
   * Lines are sized by length, boxes by width and height, and mixing the two
   * rules is what broke this.
   *
   * The earlier version tested whether the group's MEDIAN extent on an axis was
   * near zero, and wrote that median onto every member. In a group of sun rays,
   * one vertical (3 by 37), one horizontal (35 by 4), one diagonal, both medians
   * are healthy, so the vertical ray was stretched from 3px wide to the group
   * median and came back as a 45 degree diagonal. The op had changed the
   * direction of a stroke, which is not a size change by any reading.
   *
   * A line has no meaningful width to agree on, only a length. So the two kinds
   * are separated and each agrees with its own: lines scale uniformly onto a
   * median length, which leaves vertical vertical, and boxes keep the per-axis
   * median they always had.
   *
   * Both are judged on the untilted box, and so is every median below. resize
   * writes width and height, which are what an element measures before it is
   * turned, so a median taken off the turned extents gets written into a frame it
   * was never measured in: a 200 by 40 bar at 45 degrees covers a 170 square, and
   * sizing it to 170 leaves the next run measuring 148 and sizing it again, on and
   * on. It would also read that bar as a solid rather than the line it plainly is.
   * A tilt decides where a member sits, which is place()'s problem, not how big it
   * is in its own frame.
   */
  const oneDimensional = ({ raw }: Placed): boolean =>
    Math.min(raw.width, raw.height) < LINE_ASPECT * Math.max(raw.width, raw.height);

  const lines = boxes.filter(oneDimensional);
  const solids = boxes.filter((b) => !oneDimensional(b));

  if (lines.length >= 2) {
    const target = median(lines.map(({ raw }) => Math.hypot(raw.width, raw.height)));
    if (target >= 1) {
      for (const { member, raw } of lines) {
        const length = Math.hypot(raw.width, raw.height);
        if (length < 1) continue;
        const scale = target / length;
        ops.resize(member.draft, raw.width * scale, raw.height * scale);
      }
    }
  }

  if (solids.length >= 2) {
    // Median rather than mean, so one oversized member does not inflate the
    // whole group. The align engine sizes its tolerance off a median too.
    const width = median(solids.map((b) => b.raw.width));
    const height = median(solids.map((b) => b.raw.height));
    if (width < 1 && height < 1) return;
    for (const { member, raw } of solids) {
      ops.resize(member.draft, width < 1 ? raw.width : width, height < 1 ? raw.height : height);
    }
  }
}

/**
 * How many times the stroke swaps which side of its own best fit it is on.
 *
 * The measure fitLine reports is a mean distance, and a distance says nothing
 * about direction: a short stroke with a shaky hand in it scores the same as a
 * wide gentle arch. This is the part that tells them apart. A bow is on one side
 * the whole way through its middle and on the other at both ends, so it swaps
 * twice however wide or narrow it is drawn. Wobble swaps every few points.
 */
function sideChanges(points: readonly Point[], line: LineFit): number {
  const [ox, oy] = line.origin;
  const [vx, vy] = line.direction;
  const offsets = points.map(([x, y]) => (x - ox) * -vy + (y - oy) * vx);

  let widest = 0;
  for (const offset of offsets) widest = Math.max(widest, Math.abs(offset));
  if (widest <= 0) return 0;

  const deadband = widest * SIDE_DEADBAND;
  let changes = 0;
  let side = 0;
  for (const offset of offsets) {
    // Points hugging the fit have no side worth counting. Skipping them is what
    // stops the jitter where a shakily drawn bow crosses its own fit from
    // reading as four or five swaps and losing the bow.
    if (Math.abs(offset) < deadband) continue;
    const next = offset > 0 ? 1 : -1;
    if (side !== 0 && next !== side) changes++;
    side = next;
  }
  return changes;
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
  // bends, and a bend is not just a matter of how far off its own best fit the
  // stroke strays, see STRAIGHT_RESIDUAL, but of whether it strays to one side.
  const span = pathLength(points);
  if (span <= 0 || dist(from, to) / span < CLOSED_GAP_RATIO) return;

  const extent = bbox(points);
  const diagonal = Math.hypot(extent.width, extent.height);
  if (diagonal <= 0) return;

  // Total least squares, not first-point-to-last: a stroke that overshoots at
  // one end would otherwise tilt the whole segment to chase the overshoot.
  const line = fitLine(points);
  const error = line.residual / diagonal;
  if (error > WOBBLE_RESIDUAL) return;
  // Far enough off the line to be doing something, and doing it to one side the
  // whole way, makes this an arch or a smile. Flattening that is the same
  // destruction as flattening the window, just harder to spot afterwards: a
  // 137 degree rainbow came back as two points and nothing looked broken.
  if (error > STRAIGHT_RESIDUAL && sideChanges(points, line) <= BOW_SIDE_CHANGES) return;

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
