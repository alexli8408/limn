"""Photograph of a physical whiteboard to editable Excalidraw geometry.

The pipeline is: flatten the perspective, separate ink from board, thin the ink
to a one-pixel skeleton, walk that skeleton into polylines, then hand each
polyline to the shape fitter.

Skeletonising before tracing is the step that makes the output *editable* rather
than merely traced. Running findContours on the thresholded ink gives you the
outline of the marker stroke, a rectangle comes back as two nested rings, one
just outside the ink and one just inside, and neither is the rectangle. Thinning
to the stroke's centreline first means a rectangle traces as one closed path
that the fitter can turn into an actual rectangle element.
"""

from __future__ import annotations

import base64
import binascii
import math

import cv2
import numpy as np

from .schemas import ShapeSpec
from .shapes import fit_polyline

#: 8-connected neighbourhood, ordered so a walk turns consistently.
_NEIGHBOURS = ((-1, -1), (-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1))

#: Excalidraw's default stroke palette, in BGR for direct comparison with OpenCV.
_PALETTE = {
    "#1e1e1e": (30, 30, 30),
    "#e03131": (49, 49, 224),
    "#2f9e44": (68, 158, 47),
    "#1971c2": (194, 113, 25),
    "#f08c00": (0, 140, 240),
    "#9c36b5": (181, 54, 156),
}


class DecodeError(ValueError):
    """The payload was not a decodable image."""


def decode_image(image_base64: str) -> np.ndarray:
    payload = image_base64.strip()
    if payload.startswith("data:"):
        _, _, payload = payload.partition(",")
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise DecodeError("image_base64 is not valid base64") from exc

    buf = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        raise DecodeError("could not decode image bytes")
    return img


def downscale(img: np.ndarray, max_dim: int) -> np.ndarray:
    h, w = img.shape[:2]
    longest = max(h, w)
    if longest <= max_dim:
        return img
    scale = max_dim / longest
    # INTER_AREA is the correct choice for downscaling; the default bilinear
    # aliases badly and the aliasing survives thresholding as speckle.
    return cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)


def _order_quad(pts: np.ndarray) -> np.ndarray:
    """Orders four corners as top-left, top-right, bottom-right, bottom-left."""
    ordered = np.zeros((4, 2), dtype=np.float32)
    total = pts.sum(axis=1)
    diff = np.diff(pts, axis=1).ravel()
    ordered[0] = pts[np.argmin(total)]
    ordered[2] = pts[np.argmax(total)]
    ordered[1] = pts[np.argmin(diff)]
    ordered[3] = pts[np.argmax(diff)]
    return ordered


def deskew(img: np.ndarray) -> tuple[np.ndarray, bool]:
    """Finds the board's border and flattens it to a rectangle.

    Photos of a whiteboard are almost never taken square on, and the resulting
    keystone makes every rectangle on the board fit as a trapezoid. Correcting
    it once here is far more reliable than trying to be robust to it downstream.
    """
    h, w = img.shape[:2]
    grey = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(grey, (5, 5), 0)
    edges = cv2.Canny(blurred, 50, 150)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)

    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return img, False

    image_area = float(h * w)
    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:8]:
        area = float(cv2.contourArea(contour))
        # Must cover most of the frame, or we are "correcting" a sticky note.
        if area < image_area * 0.35:
            break
        approx = cv2.approxPolyDP(contour, 0.02 * cv2.arcLength(contour, True), True)
        if len(approx) != 4 or not cv2.isContourConvex(approx):
            continue

        quad = _order_quad(approx.reshape(4, 2).astype(np.float32))
        width = int(max(np.linalg.norm(quad[1] - quad[0]), np.linalg.norm(quad[2] - quad[3])))
        height = int(max(np.linalg.norm(quad[3] - quad[0]), np.linalg.norm(quad[2] - quad[1])))
        if width < 80 or height < 80:
            continue

        target = np.array(
            [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]],
            dtype=np.float32,
        )
        matrix = cv2.getPerspectiveTransform(quad, target)
        flattened = cv2.warpPerspective(img, matrix, (width, height))

        # Trim a thin margin. The detected quad never lands exactly on the board
        # edge, so a rim of whatever was outside it survives the warp, and a
        # high-contrast rim is precisely what adaptiveThreshold reads as a long
        # straight stroke down the side of the diagram.
        inset = max(2, int(min(width, height) * 0.012))
        return flattened[inset : height - inset, inset : width - inset], True

    return img, False


def extract_ink(img: np.ndarray) -> np.ndarray:
    """Separates marker from board, returning a clean binary mask.

    Adaptive thresholding rather than a global one: whiteboards photograph with
    a strong illumination gradient and glare hotspots, and any single threshold
    either loses strokes in the shadowed corner or turns the glare into ink.
    """
    grey = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # Edge-preserving denoise, a plain blur softens thin strokes into nothing.
    grey = cv2.bilateralFilter(grey, 7, 60, 60)

    block = max(11, (min(img.shape[:2]) // 20) | 1)
    mask = cv2.adaptiveThreshold(
        grey, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, block, 9
    )

    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))

    # Drop specks: dust, pen marks on the frame, JPEG noise in the glare.
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    cleaned = np.zeros_like(mask)
    min_area = max(12, (img.shape[0] * img.shape[1]) // 40_000)
    for label in range(1, count):
        if stats[label, cv2.CC_STAT_AREA] >= min_area:
            cleaned[labels == label] = 255
    return cleaned


def skeletonise(mask: np.ndarray) -> np.ndarray:
    """Thins to a one-pixel centreline, then removes diagonal redundancy."""
    thinned = cv2.ximgproc.thinning(mask, thinningType=cv2.ximgproc.THINNING_ZHANGSUEN)
    return prune_redundant(thinned)


def prune_redundant(skel: np.ndarray) -> np.ndarray:
    """Deletes pixels that are not needed to keep the skeleton connected.

    Zhang-Suen guarantees a one-pixel-wide result but not a *topologically clean*
    one: where the centreline steps diagonally, it leaves pixels with three
    8-neighbours that are plainly mid-stroke. Measured on a plain 360x220 ellipse,
    the raw thinned skeleton has 311 such pixels out of 930, a third of the
    curve. Any graph built on that sees two dozen junctions where there are none,
    and the ellipse arrives in twenty pieces. After this pass: zero.

    The test for redundancy is local and exact: if some neighbour q of p is itself
    adjacent to every *other* neighbour of p, then deleting p leaves all of them
    connected through q, so p carries no connectivity. Iterated to a fixed point,
    this leaves a skeleton whose interior pixels genuinely have degree two.
    """
    occupied = skel > 0
    height, width = occupied.shape

    while True:
        degree = _degree_map(occupied)
        removed = False
        for y, x in np.argwhere((degree >= 3) & occupied):
            y, x = int(y), int(x)
            if not occupied[y, x]:
                continue
            neighbours = [
                (y + dy, x + dx)
                for dy, dx in _NEIGHBOURS
                if 0 <= y + dy < height and 0 <= x + dx < width and occupied[y + dy, x + dx]
            ]
            for q in neighbours:
                others = [n for n in neighbours if n != q]
                if all(
                    max(abs(n[0] - q[0]), abs(n[1] - q[1])) <= 1 for n in others
                ):
                    occupied[y, x] = False
                    removed = True
                    break
        if not removed:
            break

    return (occupied.astype(np.uint8)) * 255


def _degree_map(occupied: np.ndarray) -> np.ndarray:
    """8-neighbour count for every skeleton pixel, vectorised."""
    h, w = occupied.shape
    padded = np.pad(occupied.astype(np.uint8), 1)
    degree = np.zeros((h, w), dtype=np.uint8)
    for dy, dx in _NEIGHBOURS:
        degree += padded[1 + dy : 1 + dy + h, 1 + dx : 1 + dx + w]
    return degree * occupied.astype(np.uint8)


def _order_branch(pixels: set[tuple[int, int]]) -> list[tuple[int, int]]:
    """Puts one branch's pixels into path order."""

    def neighbours(p: tuple[int, int]) -> list[tuple[int, int]]:
        return [
            (p[0] + dy, p[1] + dx)
            for dy, dx in _NEIGHBOURS
            if (p[0] + dy, p[1] + dx) in pixels
        ]

    start = next((p for p in pixels if len(neighbours(p)) <= 1), None)
    if start is None:  # a closed loop with no free end
        start = next(iter(pixels))

    path = [start]
    visited = {start}
    while True:
        cursor = path[-1]
        previous = path[-2] if len(path) >= 2 else cursor
        candidates = [q for q in neighbours(cursor) if q not in visited]
        if not candidates:
            break
        # Step to whichever candidate is farthest from where we came from. On a
        # staircase the cursor touches both the previous pixel and the true
        # continuation, and this keeps the walk moving forward rather than
        # shuffling sideways into the step.
        nxt = max(candidates, key=lambda q: (q[0] - previous[0]) ** 2 + (q[1] - previous[1]) ** 2)
        path.append(nxt)
        visited.add(nxt)
    return path


class SkeletonGraph:
    """A thinned image as branches joined at junction nodes.

    The whole design turns on grouping junction *pixels* into junction *nodes*.
    Thinning does not leave one tidy branch point where strokes meet; it leaves a
    small clump of degree-3 pixels, and between them run one- and two-pixel
    stubs. Treating every such pixel as its own junction produces a swarm of
    micro-fragments, and then any rule of the form "two ends meeting must belong
    together" chains straight through a real T, which is how two boxes and the
    connector between them end up as a single polyline.

    Dilating the junction mask before labelling collapses each clump to one node.
    Every remaining branch then runs between two distinct nodes (or ends free),
    the count of branches at a node is finally meaningful, and short dead-end
    stubs can be discarded safely because they are no longer load-bearing.
    """

    def __init__(self, skel: np.ndarray) -> None:
        occupied = skel > 0
        degree = _degree_map(occupied)

        junction = ((degree >= 3) & occupied).astype(np.uint8)
        node_mask = cv2.dilate(junction, np.ones((3, 3), np.uint8), iterations=1)
        node_mask = (node_mask.astype(bool) & occupied).astype(np.uint8)
        node_count, node_labels = cv2.connectedComponents(node_mask, connectivity=8)

        branch_mask = (occupied & ~node_mask.astype(bool)).astype(np.uint8)
        branch_count, branch_labels = cv2.connectedComponents(branch_mask, connectivity=8)

        self.node_count = node_count
        #: Centroid of each junction cluster, used to bridge merges. The node's
        #: own pixels are excluded from every branch, so joining two branches
        #: without putting something back leaves a gap the width of the cluster.
        self.node_centres: dict[int, np.ndarray] = {}
        for label in range(1, node_count):
            ys, xs = np.nonzero(node_labels == label)
            if len(xs):
                self.node_centres[label] = np.array(
                    [xs.mean(), ys.mean()], dtype=np.float32
                )
        self.branches: list[np.ndarray] = []
        #: For each branch, the node id at each end, or None where it ends free.
        self.ends: list[tuple[int | None, int | None]] = []

        height, width = occupied.shape
        pixels_by_branch: dict[int, set[tuple[int, int]]] = {}
        for y, x in np.argwhere(branch_mask):
            pixels_by_branch.setdefault(int(branch_labels[y, x]), set()).add((int(y), int(x)))

        def node_touching(pixel: tuple[int, int]) -> int | None:
            y, x = pixel
            for dy, dx in _NEIGHBOURS:
                ny, nx = y + dy, x + dx
                if 0 <= ny < height and 0 <= nx < width and node_mask[ny, nx]:
                    return int(node_labels[ny, nx])
            return None

        for label in range(1, branch_count):
            pixels = pixels_by_branch.get(label)
            if not pixels:
                continue
            ordered = _order_branch(pixels)
            if len(ordered) < 2:
                # A single pixel wedged between junctions carries no direction;
                # the nodes it bridges are effectively one node anyway.
                continue
            self.branches.append(np.array([(x, y) for y, x in ordered], dtype=np.float32))
            self.ends.append((node_touching(ordered[0]), node_touching(ordered[-1])))

        # A shape with no junction at all (a lone ellipse) has no branch pixels
        # removed, so it survives as one loop in the branch pass above.
        if branch_count <= 1 and node_count <= 1 and occupied.any():
            pixels = {(int(y), int(x)) for y, x in np.argwhere(occupied)}
            ordered = _order_branch(pixels)
            if len(ordered) >= 2:
                self.branches.append(np.array([(x, y) for y, x in ordered], dtype=np.float32))
                self.ends.append((None, None))


def assemble_branches(
    graph: SkeletonGraph,
    spur_px: float = 6.0,
    continuity_degrees: float = 125.0,
) -> list[np.ndarray]:
    """Joins branches back into strokes, one decision per junction node.

    * A node with two branches is a corner the thinning split. Join outright,
      a corner is a 90 degree turn, so a continuity test would reject precisely
      the case being repaired.
    * A node with three or more is a real junction. Join only the straightest
      through-pair, which reunites a box's side while leaving the connector that
      landed on it as its own element.
    """
    continuity_limit = math.cos(math.radians(continuity_degrees))
    branches = graph.branches
    lengths = [
        float(np.linalg.norm(np.diff(b, axis=0), axis=1).sum()) if len(b) > 1 else 0.0
        for b in branches
    ]

    # Short dead ends are thinning stubs. Safe to drop only because junction
    # clustering means nothing short is bridging two separate nodes.
    alive = [
        not (
            lengths[i] < spur_px
            and (graph.ends[i][0] is None or graph.ends[i][1] is None)
        )
        for i in range(len(branches))
    ]

    at_node: dict[int, list[tuple[int, int]]] = {}
    for i, (start_node, end_node) in enumerate(graph.ends):
        if not alive[i]:
            continue
        for end_id, node in enumerate((start_node, end_node)):
            if node is not None:
                at_node.setdefault(node, []).append((i, end_id))

    def direction(branch_index: int, end_id: int) -> np.ndarray:
        pts = branches[branch_index]
        oriented = pts if end_id == 1 else pts[::-1]
        step = min(len(oriented) - 1, 10)
        delta = oriented[-1 - step] - oriented[-1]
        length = float(np.linalg.norm(delta))
        return delta / length if length > 1e-6 else np.zeros(2, dtype=np.float32)

    partner: dict[tuple[int, int], tuple[int, int]] = {}
    for members in at_node.values():
        free = [m for m in members if m not in partner]
        if len({m[0] for m in free}) < 2:
            continue

        if len(free) == 2:
            partner[free[0]] = free[1]
            partner[free[1]] = free[0]
            continue

        best: tuple[float, tuple[int, int], tuple[int, int]] | None = None
        for a in range(len(free)):
            for b in range(a + 1, len(free)):
                if free[a][0] == free[b][0]:
                    continue
                alignment = float(np.dot(direction(*free[a]), direction(*free[b])))
                if best is None or alignment < best[0]:
                    best = (alignment, free[a], free[b])
        if best is not None and best[0] <= continuity_limit:
            partner[best[1]] = best[2]
            partner[best[2]] = best[1]

    consumed = [not a for a in alive]
    merged: list[np.ndarray] = []

    def build(start: tuple[int, int]) -> list[np.ndarray]:
        chunks: list[np.ndarray] = []
        cursor = start
        while True:
            index, entry = cursor
            if consumed[index]:
                break
            consumed[index] = True
            pts = branches[index] if entry == 0 else branches[index][::-1]
            chunks.append(pts if not chunks else pts[1:])

            exit_end = 1 - entry
            following = partner.get((index, exit_end))
            if following is None:
                break
            # Put the junction's own pixels back as a single bridging point, or
            # the stroke jumps across the cluster the node mask swallowed.
            node = graph.ends[index][exit_end]
            centre = graph.node_centres.get(node) if node is not None else None
            if centre is not None:
                chunks.append(centre.reshape(1, 2))
            cursor = following
        return chunks

    # Free ends first, so open strokes assemble whole instead of from the middle.
    for index in range(len(branches)):
        if consumed[index]:
            continue
        for end_id in (0, 1):
            if (index, end_id) in partner:
                continue
            chunks = build((index, end_id))
            if chunks:
                merged.append(np.vstack(chunks))
            break

    # Anything left has both ends paired, i.e. it is a closed loop.
    for index in range(len(branches)):
        if consumed[index]:
            continue
        chunks = build((index, 0))
        if chunks:
            merged.append(np.vstack(chunks))

    return [m for m in merged if len(m) >= 3]


def trace_skeleton(skel: np.ndarray, min_length: int = 20) -> list[np.ndarray]:
    """Walks a thinned image into polylines, one per stroke."""
    graph = SkeletonGraph(skel)
    strokes = assemble_branches(graph)
    return [
        s
        for s in strokes
        if float(np.linalg.norm(np.diff(s, axis=0), axis=1).sum()) >= min_length
    ]


def sample_stroke_colour(img: np.ndarray, polyline: np.ndarray) -> str:
    """Recovers the marker colour and snaps it to the nearest palette entry.

    Sampled a few pixels off the centreline in both normals and taken as a
    median, because the centreline of a dark stroke on a bright board picks up
    the board's own colour at thin strokes.
    """
    h, w = img.shape[:2]
    samples: list[np.ndarray] = []
    step = max(1, len(polyline) // 40)
    for i in range(0, len(polyline), step):
        x, y = polyline[i]
        xi, yi = int(round(x)), int(round(y))
        if 0 <= xi < w and 0 <= yi < h:
            patch = img[max(0, yi - 1) : yi + 2, max(0, xi - 1) : xi + 2]
            if patch.size:
                samples.append(patch.reshape(-1, 3))
    if not samples:
        return "#1e1e1e"

    stacked = np.vstack(samples).astype(np.float32)
    # Ink is the dark end of the distribution; the rest is board showing through.
    luminance = stacked @ np.array([0.114, 0.587, 0.299], dtype=np.float32)
    ink = stacked[luminance <= np.percentile(luminance, 35)]
    median = np.median(ink if len(ink) else stacked, axis=0)

    best, best_dist = "#1e1e1e", math.inf
    for hex_code, bgr in _PALETTE.items():
        dist = float(np.linalg.norm(median - np.array(bgr, dtype=np.float32)))
        if dist < best_dist:
            best, best_dist = hex_code, dist
    return best


def vectorize(
    img: np.ndarray,
    *,
    do_deskew: bool = True,
    max_dim: int = 1600,
    min_stroke_px: int = 26,
    fit_shapes: bool = True,
) -> tuple[list[ShapeSpec], bool, int]:
    """Runs the whole pipeline. Returns (shapes, deskewed, traced_count)."""
    img = downscale(img, max_dim)
    deskewed = False
    if do_deskew:
        img, deskewed = deskew(img)

    mask = extract_ink(img)
    skeleton = skeletonise(mask)
    polylines = trace_skeleton(skeleton, min_length=min_stroke_px)

    shapes: list[ShapeSpec] = []
    for index, polyline in enumerate(polylines):
        # Simplify before fitting: a traced skeleton is one point per pixel, and
        # that density buys no accuracy while costing real time downstream.
        epsilon = max(1.0, 0.004 * float(cv2.arcLength(polyline.reshape(-1, 1, 2), False)))
        simplified = cv2.approxPolyDP(polyline.reshape(-1, 1, 2), epsilon, False).reshape(-1, 2)
        if len(simplified) < 2:
            continue

        colour = sample_stroke_colour(img, polyline)
        # Fit from the full trace, not the simplified copy. approxPolyDP reduces a
        # straight connector to two points, which every "is this a shape?" test
        # then declines for having too little geometry to judge. The simplified
        # copy is only for the freedraw fallback, where point count is the cost.
        if fit_shapes:
            spec = fit_polyline(polyline, stroke_id=f"trace-{index}")
        else:
            x0 = float(simplified[:, 0].min())
            y0 = float(simplified[:, 1].min())
            spec = ShapeSpec(
                id=f"trace-{index}",
                kind="freedraw",
                confidence=0.0,
                x=x0,
                y=y0,
                width=float(simplified[:, 0].max() - x0),
                height=float(simplified[:, 1].max() - y0),
                points=[[float(p[0] - x0), float(p[1] - y0)] for p in simplified],
            )

        if spec.kind == "freedraw" and spec.points is None:
            x0 = float(simplified[:, 0].min())
            y0 = float(simplified[:, 1].min())
            spec.x, spec.y = x0, y0
            spec.width = float(simplified[:, 0].max() - x0)
            spec.height = float(simplified[:, 1].max() - y0)
            spec.points = [[float(p[0] - x0), float(p[1] - y0)] for p in simplified]

        spec.stroke_color = colour
        shapes.append(spec)

    return shapes, deskewed, len(polylines)
