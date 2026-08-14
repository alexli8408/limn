"""Shape fitting from stroke geometry, using OpenCV's contour machinery.

This complements the recogniser that runs in the browser rather than duplicating
it. The client path is polyline-based and answers within a frame, which is what
snapping needs. This path rasterises and fills first, so it keeps working on
input the polyline path cannot interpret: a rectangle drawn in three overlapping
passes, a circle whose ends cross well past each other, a shape traced twice
because the first attempt looked wrong.

It is also the fitter used on strokes recovered from a photograph, where none of
the timing or ordering information a polyline recogniser relies on exists.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import cv2
import numpy as np

from .raster import (
    CANVAS,
    Normalisation,
    aspect_normalise,
    largest_contour,
    normalisation_for,
    rasterise,
)
from .schemas import ShapeMetrics, ShapeSpec

# --------------------------------------------------------------------------
# Hu-moment templates
# --------------------------------------------------------------------------


def _template(draw) -> np.ndarray:
    canvas = np.zeros((CANVAS, CANVAS), dtype=np.uint8)
    draw(canvas)
    contours, _ = cv2.findContours(canvas, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    return aspect_normalise(max(contours, key=cv2.contourArea))


def _build_templates() -> dict[str, np.ndarray]:
    c, r = CANVAS // 2, CANVAS // 2 - 24

    def circle(img):
        cv2.circle(img, (c, c), r, 255, -1)

    def square(img):
        cv2.rectangle(img, (c - r, c - r), (c + r, c + r), 255, -1)

    def triangle(img):
        pts = np.array([[c, c - r], [c + r, c + r], [c - r, c + r]], np.int32)
        cv2.fillPoly(img, [pts], 255)

    return {
        "ellipse": _template(circle),
        "rectangle": _template(square),
        "triangle": _template(triangle),
    }


#: Built once at import. Each is already aspect-normalised, so matching is
#: invariant to rotation, scale *and* aspect.
TEMPLATES = _build_templates()


# --------------------------------------------------------------------------
# scoring helpers
# --------------------------------------------------------------------------


def _gauss(x: float, mu: float, sigma: float) -> float:
    return math.exp(-((x - mu) ** 2) / (2.0 * sigma * sigma))


def _combine(*factors: tuple[float, float]) -> float:
    """Weighted geometric mean, see the note in packages/shapes/src/score.ts.

    A plain product of five plausible-looking factors lands around 0.4, which
    sits under any sensible threshold and makes the fitter refuse everything.
    """
    total_w = 0.0
    acc = 0.0
    for score, weight in factors:
        acc += weight * math.log(max(score, 1e-6))
        total_w += weight
    return math.exp(acc / total_w) if total_w > 0 else 0.0


@dataclass
class ContourAnalysis:
    contour: np.ndarray
    vertices: np.ndarray
    area: float
    perimeter: float
    circularity: float
    rect_fill: float
    solidity: float
    min_rect: tuple
    template_distance: dict[str, float] = field(default_factory=dict)


def analyse(contour: np.ndarray) -> ContourAnalysis:
    area = float(cv2.contourArea(contour))
    perimeter = float(cv2.arcLength(contour, True))
    circularity = (4.0 * math.pi * area / (perimeter**2)) if perimeter > 0 else 0.0

    approx = cv2.approxPolyDP(contour, 0.025 * perimeter, True)
    hull = cv2.convexHull(contour)
    hull_area = max(float(cv2.contourArea(hull)), 1e-6)

    (_, _), (w, h), _ = rect = cv2.minAreaRect(contour)
    rect_area = max(w * h, 1e-6)

    normalised = aspect_normalise(contour)
    distances = {
        name: float(cv2.matchShapes(normalised, tmpl, cv2.CONTOURS_MATCH_I2, 0.0))
        for name, tmpl in TEMPLATES.items()
    }

    return ContourAnalysis(
        contour=contour,
        vertices=approx.reshape(-1, 2),
        area=area,
        perimeter=perimeter,
        circularity=circularity,
        rect_fill=area / rect_area,
        solidity=area / hull_area,
        min_rect=rect,
        template_distance=distances,
    )


def _quad_diagonals(quad: np.ndarray, diag: float) -> tuple[float, float, np.ndarray, float, float]:
    """Skew, midpoint offset, centre and the two diagonal lengths of a quad.

    A diamond is a quadrilateral whose diagonals are perpendicular and bisect
    each other. Testing that directly is rotation-invariant, and it avoids the
    trap that area-over-min-area-rect cannot separate a diamond from a
    rectangle: a diamond's minimal enclosing rectangle is edge-aligned, so that
    ratio sits near 0.75 rather than the 0.5 the axis-aligned box would suggest.
    """
    a, b, c, d = quad[0], quad[1], quad[2], quad[3]
    v1 = c - a
    v2 = d - b
    l1 = float(np.linalg.norm(v1))
    l2 = float(np.linalg.norm(v2))
    if l1 < 1e-6 or l2 < 1e-6:
        return 1.0, 1.0, np.array([0.0, 0.0]), 0.0, 0.0

    skew = abs(float(np.dot(v1, v2))) / (l1 * l2)
    m1 = (a + c) / 2.0
    m2 = (b + d) / 2.0
    offset = float(np.linalg.norm(m1 - m2)) / max(diag, 1e-6)
    return skew, offset, (m1 + m2) / 2.0, l1, l2


def _interior_angles(poly: np.ndarray) -> list[float]:
    n = len(poly)
    out: list[float] = []
    for i in range(n):
        prev, cur, nxt = poly[(i - 1) % n], poly[i], poly[(i + 1) % n]
        v1 = prev - cur
        v2 = nxt - cur
        n1 = np.linalg.norm(v1)
        n2 = np.linalg.norm(v2)
        if n1 < 1e-6 or n2 < 1e-6:
            continue
        cosine = float(np.dot(v1, v2) / (n1 * n2))
        out.append(math.acos(max(-1.0, min(1.0, cosine))))
    return out


def _detect_arrowhead(pts: np.ndarray) -> tuple[bool, np.ndarray, np.ndarray]:
    """A straight shaft that folds back on itself to draw the barbs."""
    if len(pts) < 8:
        return False, pts[0], pts[-1]

    # DIST_HUBER rather than least squares: the barbs are genuine outliers and
    # would otherwise drag the shaft's direction off by several degrees.
    head = pts[: max(2, int(len(pts) * 0.55))]
    vx, vy, _, _ = cv2.fitLine(head.astype(np.float32), cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
    direction = np.array([vx, vy], dtype=np.float32)
    if float(np.dot(pts[-1] - pts[0], direction)) < 0:
        direction = -direction

    proj = (pts - pts[0]) @ direction
    tip_idx = int(np.argmax(proj))
    tip_proj = float(proj[tip_idx])

    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    total = float(seg.sum())
    if total <= 0:
        return False, pts[0], pts[-1]
    arc_to_tip = float(seg[:tip_idx].sum())
    tail = total - arc_to_tip

    if arc_to_tip < total * 0.45 or not (total * 0.06 < tail < total * 0.5):
        return False, pts[0], pts[-1]
    if tip_idx + 1 >= len(proj) or float(np.max(proj[tip_idx + 1 :])) > tip_proj * 0.96:
        return False, pts[0], pts[-1]

    return True, pts[0], pts[tip_idx]


# --------------------------------------------------------------------------
# public entry point
# --------------------------------------------------------------------------


def fit_polyline(
    points: np.ndarray,
    stroke_id: str | None = None,
    min_confidence: float = 0.55,
) -> ShapeSpec:
    """Classifies one polyline and returns an idealised replacement."""
    pts = np.asarray(points, dtype=np.float32).reshape(-1, 2)
    if len(pts) < 3:
        return ShapeSpec(id=stroke_id, kind="freedraw", confidence=0.0)

    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    arc = float(seg.sum())
    width = float(pts[:, 0].max() - pts[:, 0].min())
    height = float(pts[:, 1].max() - pts[:, 1].min())
    diag_src = math.hypot(width, height)
    if arc < 1e-3 or diag_src < 1e-3:
        return ShapeSpec(id=stroke_id, kind="freedraw", confidence=0.0)

    gap_ratio = float(np.linalg.norm(pts[-1] - pts[0])) / arc
    closed = gap_ratio < 0.22

    norm = normalisation_for(pts)
    canvas_pts = norm.to_canvas(pts)

    # Open strokes are judged from the points directly. Rasterising first buys
    # nothing for them and actively breaks the flat cases: a near-horizontal
    # connector fills a band whose contour has four points, which the
    # closed-shape path rejects out of hand as degenerate.
    if not closed:
        return _fit_open(canvas_pts, gap_ratio, norm, stroke_id, min_confidence)

    mask = rasterise(canvas_pts, closed)
    contour = largest_contour(mask)
    if contour is None or len(contour) < 5:
        return ShapeSpec(id=stroke_id, kind="freedraw", confidence=0.0)

    info = analyse(contour)
    diag_canvas = math.hypot(*cv2.minAreaRect(contour)[1])
    scores: dict[str, float] = {}

    verts = info.vertices
    n_verts = len(verts)
    angles = _interior_angles(verts) if n_verts >= 3 else []
    rightness = (
        float(np.mean([_gauss(a, math.pi / 2, 0.30) for a in angles])) if angles else 0.0
    )

    # Hu distance carries the curved-vs-straight decision; it is the one
    # signal here that survives arbitrary rotation and aspect.
    scores["ellipse"] = _combine(
        (_gauss(info.template_distance.get("ellipse", 9.9), 0.0, 0.10), 3),
        (_gauss(info.circularity, 1.0, 0.24), 1),
        (_gauss(info.solidity, 1.0, 0.13), 1),
    )

    if n_verts == 3:
        scores["triangle"] = _combine(
            (_gauss(info.template_distance.get("triangle", 9.9), 0.0, 0.14), 2),
            (_gauss(info.rect_fill, 0.5, 0.14), 2),
            (_gauss(info.solidity, 1.0, 0.14), 1),
        )

    if n_verts == 4:
        skew, offset, centre, l1, l2 = _quad_diagonals(verts.astype(np.float32), diag_canvas)
        scores["rectangle"] = _combine(
            (rightness, 3),
            (_gauss(info.template_distance.get("rectangle", 9.9), 0.0, 0.12), 2),
            (_gauss(info.solidity, 1.0, 0.12), 1),
        )
        scores["diamond"] = _combine(
            (_gauss(skew, 0.0, 0.22), 3),
            (_gauss(offset, 0.0, 0.05), 2),
            (_gauss(info.solidity, 1.0, 0.12), 1),
        )

    if 5 <= n_verts <= 10:
        scores["polygon"] = _combine(
            (_gauss(info.solidity, 1.0, 0.13), 2),
            (1.0 - _gauss(info.template_distance.get("ellipse", 9.9), 0.0, 0.10), 2),
            (0.8, 1),
        )

    metrics = ShapeMetrics(
        circularity=round(info.circularity, 4),
        rect_fill=round(info.rect_fill, 4),
        solidity=round(info.solidity, 4),
        vertices=int(len(info.vertices)),
        closed=closed,
        template_distance=round(min(info.template_distance.values(), default=0.0), 5),
    )

    if not scores:
        return ShapeSpec(id=stroke_id, kind="freedraw", confidence=0.0, metrics=metrics)

    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    kind, top = ranked[0]
    runner = ranked[1][1] if len(ranked) > 1 else 0.0
    confidence = min(1.0, top * (0.7 + 0.3 * min(1.0, (top - runner) / 0.2)))

    if confidence < min_confidence:
        return ShapeSpec(id=stroke_id, kind="freedraw", confidence=confidence, metrics=metrics)

    return _idealise(kind, confidence, metrics, info, canvas_pts, norm, stroke_id, closed)


def _fit_open(
    canvas_pts: np.ndarray,
    gap_ratio: float,
    norm: Normalisation,
    stroke_id: str | None,
    min_confidence: float,
) -> ShapeSpec:
    """Classifies an open stroke as a line, an arrow, or neither."""
    diag = math.hypot(*cv2.minAreaRect(canvas_pts.reshape(-1, 1, 2))[1])
    vx, vy, x0, y0 = cv2.fitLine(
        canvas_pts.astype(np.float32), cv2.DIST_HUBER, 0, 0.01, 0.01
    ).ravel()
    rel = canvas_pts - np.array([x0, y0], dtype=np.float32)
    residual = float(np.mean(np.abs(rel[:, 0] * -vy + rel[:, 1] * vx))) / max(diag, 1e-6)

    scores = {
        "line": _combine((_gauss(residual, 0.0, 0.045), 3), (_gauss(gap_ratio, 1.0, 0.4), 1))
    }
    is_arrow, _, _ = _detect_arrowhead(canvas_pts)
    if is_arrow:
        scores["arrow"] = _combine((_gauss(residual, 0.0, 0.16), 1), (0.9, 2))

    metrics = ShapeMetrics(closed=False, vertices=2)
    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    kind, top = ranked[0]
    runner = ranked[1][1] if len(ranked) > 1 else 0.0
    confidence = min(1.0, top * (0.7 + 0.3 * min(1.0, (top - runner) / 0.2)))

    if confidence < min_confidence:
        return ShapeSpec(id=stroke_id, kind="freedraw", confidence=confidence, metrics=metrics)

    if kind == "arrow":
        _, tail, tip = _detect_arrowhead(canvas_pts)
    else:
        axis = canvas_pts[-1] - canvas_pts[0]
        length = float(np.linalg.norm(axis))
        unit = axis / length if length > 1e-6 else np.array([1.0, 0.0], dtype=np.float32)
        proj = (canvas_pts - canvas_pts[0]) @ unit
        tail = canvas_pts[int(np.argmin(proj))]
        tip = canvas_pts[int(np.argmax(proj))]

    ends = norm.to_source(np.stack([tail, tip]))
    origin_x, origin_y = float(min(ends[:, 0])), float(min(ends[:, 1]))
    return ShapeSpec(
        id=stroke_id,
        kind=kind,  # type: ignore[arg-type]
        confidence=round(confidence, 4),
        x=origin_x,
        y=origin_y,
        width=float(abs(ends[1][0] - ends[0][0])),
        height=float(abs(ends[1][1] - ends[0][1])),
        points=[[float(p[0] - origin_x), float(p[1] - origin_y)] for p in ends],
        metrics=metrics,
    )


def _fold_rect(w: float, h: float, angle_deg: float) -> tuple[float, float, float]:
    """Folds a min-area rect into the [-45°, 45°) band, swapping sides as needed.

    cv2.minAreaRect reports angles in [0°, 90°), so an axis-aligned box often
    comes back as "rotated 90° with the sides exchanged". Snapping that angle to
    zero without exchanging them back yields a box with its width and height
    transposed, a 300×150 rectangle placed as 150×300.
    """
    angle = math.radians(angle_deg) % math.pi
    if angle >= math.pi / 2:
        angle -= math.pi / 2
        w, h = h, w
    if angle > math.pi / 4:
        angle -= math.pi / 2
        w, h = h, w
    return w, h, angle


def _idealise(
    kind: str,
    confidence: float,
    metrics: ShapeMetrics,
    info: ContourAnalysis,
    canvas_pts: np.ndarray,
    norm: Normalisation,
    stroke_id: str | None,
    closed: bool,
) -> ShapeSpec:
    """Maps the winning hypothesis back into the caller's coordinate space."""
    (cx, cy), (raw_w, raw_h), angle_deg = info.min_rect
    w, h, angle = _fold_rect(raw_w, raw_h, angle_deg)

    def box_from_centre(centre_canvas, width_c, height_c, theta):
        centre = norm.to_source(np.array([centre_canvas], dtype=np.float32))[0]
        width_s = norm.length_to_source(width_c)
        height_s = norm.length_to_source(height_c)
        return ShapeSpec(
            id=stroke_id,
            kind=kind,  # type: ignore[arg-type]
            confidence=round(confidence, 4),
            x=float(centre[0] - width_s / 2),
            y=float(centre[1] - height_s / 2),
            width=float(width_s),
            height=float(height_s),
            angle=float(theta),
            metrics=metrics,
        )

    if kind == "diamond":
        verts = info.vertices.astype(np.float32)
        _, _, centre, l1, l2 = _quad_diagonals(verts, math.hypot(raw_w, raw_h))
        axis = verts[2] - verts[0]
        theta = math.atan2(float(axis[1]), float(axis[0]))
        return box_from_centre(centre, l1, l2, _snap_angle(theta))

    if kind == "ellipse":
        if len(info.contour) >= 5:
            # fitEllipse returns a RotatedRect with the same convention as
            # minAreaRect, so it needs the same folding: without it an ellipse
            # reported at 90° lands with its axes transposed.
            (ecx, ecy), (axis_a, axis_b), e_angle = cv2.fitEllipse(info.contour)
            ew, eh, etheta = _fold_rect(axis_a, axis_b, e_angle)
            return box_from_centre(
                np.array([ecx, ecy], dtype=np.float32), ew, eh, _snap_angle(etheta)
            )
        return box_from_centre(np.array([cx, cy], dtype=np.float32), w, h, _snap_angle(angle))

    if kind in ("triangle", "polygon"):
        verts_src = norm.to_source(info.vertices.astype(np.float32))
        ring = np.vstack([verts_src, verts_src[:1]]) if closed else verts_src
        x0, y0 = float(ring[:, 0].min()), float(ring[:, 1].min())
        return ShapeSpec(
            id=stroke_id,
            kind=kind,  # type: ignore[arg-type]
            confidence=round(confidence, 4),
            x=x0,
            y=y0,
            width=float(ring[:, 0].max() - x0),
            height=float(ring[:, 1].max() - y0),
            points=[[float(p[0] - x0), float(p[1] - y0)] for p in ring],
            metrics=metrics,
        )

    return box_from_centre(np.array([cx, cy], dtype=np.float32), w, h, _snap_angle(angle))


def _snap_angle(theta: float, tolerance: float = math.radians(8.0)) -> float:
    """Folds to the nearest π/4 when already close, and to 0 when near flat."""
    step = math.pi / 4
    nearest = round(theta / step) * step
    snapped = nearest if abs(theta - nearest) <= tolerance else theta
    return 0.0 if abs(snapped % math.pi) < 1e-6 else snapped
