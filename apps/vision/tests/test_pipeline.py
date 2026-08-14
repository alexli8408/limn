"""End-to-end checks for the vision pipeline.

The vectorisation test synthesises a whiteboard photograph rather than committing
a fixture image: it draws a known diagram, then applies the things that actually
break the pipeline in the field — a perspective warp, an illumination gradient, a
glare hotspot and sensor noise — so a regression in any one stage is visible, and
the expected output is known exactly.
"""

from __future__ import annotations

import base64
import math
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from limn_vision.shapes import fit_polyline  # noqa: E402
from limn_vision.smooth import resample, smooth_stroke  # noqa: E402
from limn_vision.vectorize import (  # noqa: E402
    decode_image,
    deskew,
    extract_ink,
    skeletonise,
    trace_skeleton,
    vectorize,
)

RNG = np.random.default_rng(20260814)


# --------------------------------------------------------------------------
# stroke synthesis
# --------------------------------------------------------------------------


def wobble(points: np.ndarray, amplitude: float) -> np.ndarray:
    noise = RNG.normal(0.0, amplitude, size=points.shape).astype(np.float32)
    drift = np.stack(
        [
            np.sin(np.linspace(0, 4.0, len(points))) * amplitude * 0.8,
            np.cos(np.linspace(0, 3.0, len(points))) * amplitude * 0.8,
        ],
        axis=1,
    ).astype(np.float32)
    return points + noise + drift


def trace_polygon(vertices: list[tuple[float, float]], jitter: float = 0.0) -> np.ndarray:
    loop = vertices + [vertices[0]]
    pts: list[tuple[float, float]] = []
    for a, b in zip(loop, loop[1:]):
        length = math.dist(a, b)
        steps = max(6, int(length / 3))
        for i in range(steps):
            t = i / steps
            pts.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    pts.append(loop[-1])
    arr = np.array(pts, dtype=np.float32)
    return wobble(arr, jitter) if jitter else arr


def trace_ellipse(cx, cy, rx, ry, jitter: float = 0.0) -> np.ndarray:
    t = np.linspace(0, 2 * math.pi, 120, dtype=np.float32)
    arr = np.stack([cx + rx * np.cos(t), cy + ry * np.sin(t)], axis=1).astype(np.float32)
    return wobble(arr, jitter) if jitter else arr


# --------------------------------------------------------------------------
# shape fitting
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name,points",
    [
        ("rectangle", trace_polygon([(60, 40), (300, 40), (300, 200), (60, 200)], 2.5)),
        ("ellipse", trace_ellipse(200, 150, 130, 90, 2.5)),
        (
            "diamond",
            trace_polygon([(200, 40), (330, 150), (200, 260), (70, 150)], 2.5),
        ),
        ("triangle", trace_polygon([(200, 40), (330, 240), (70, 240)], 2.5)),
    ],
)
def test_fits_closed_primitives(name: str, points: np.ndarray) -> None:
    spec = fit_polyline(points, stroke_id=name)
    assert spec.kind == name, f"{name} misread as {spec.kind} (conf {spec.confidence})"
    assert spec.confidence >= 0.55
    assert spec.width > 0 and spec.height > 0


def test_fits_a_line() -> None:
    line = np.array([[40 + i * 3, 60 + i * 1.4] for i in range(90)], dtype=np.float32)
    spec = fit_polyline(wobble(line, 0.8), stroke_id="line")
    assert spec.kind in ("line", "arrow")
    assert spec.points is not None and len(spec.points) == 2


def test_survives_an_overdrawn_rectangle() -> None:
    """The case that motivates rasterise-and-fill.

    Drawn twice with the second pass offset, and with corners that overshoot and
    cross. A polyline-based recogniser sees one self-intersecting path; filling
    first collapses it to the region the user meant.
    """
    base = [(50, 50), (290, 50), (290, 210), (50, 210)]
    first = trace_polygon(base, 3.0)
    second = trace_polygon([(x + 6, y - 4) for x, y in base], 3.0)
    overshoot = np.array([[50, 210], [50, 190], [56, 44], [40, 50]], dtype=np.float32)
    messy = np.vstack([first, second, overshoot])

    spec = fit_polyline(messy, stroke_id="messy")
    assert spec.kind == "rectangle", f"got {spec.kind} @ {spec.confidence}"


def test_declines_a_squiggle() -> None:
    t = np.linspace(0, 10, 220, dtype=np.float32)
    squiggle = np.stack([t * 18, np.sin(t * 2.3) * 60 + np.cos(t * 5.1) * 25], axis=1)
    assert fit_polyline(squiggle.astype(np.float32), stroke_id="sq").kind == "freedraw"


# --------------------------------------------------------------------------
# smoothing
# --------------------------------------------------------------------------


def test_smoothing_reduces_tremor_and_pins_endpoints() -> None:
    clean = np.stack(
        [np.linspace(0, 400, 200), np.full(200, 100.0)], axis=1
    ).astype(np.float32)
    noisy = wobble(clean, 3.0)

    smoothed = smooth_stroke(noisy, sigma=2.0)

    # Roughness, not absolute deviation: the generator also adds a deliberate
    # low-frequency drift (the wrist, not the fingers), and smoothing is supposed
    # to preserve that. Mean distance from each point to the midpoint of its
    # neighbours isolates the high-frequency component, which is the tremor.
    def roughness(pts: np.ndarray) -> float:
        midpoints = (pts[:-2] + pts[2:]) / 2.0
        return float(np.linalg.norm(pts[1:-1] - midpoints, axis=1).mean())

    before = roughness(noisy)
    after = roughness(smoothed)
    assert after < before * 0.5, f"tremor not reduced: {before:.3f} -> {after:.3f}"
    assert np.allclose(smoothed[0], noisy[0]), "start point drifted"
    assert np.allclose(smoothed[-1], noisy[-1]), "end point drifted"


def test_resample_hits_exact_count_and_even_spacing() -> None:
    pts = np.array([[0, 0], [100, 0], [100, 100]], dtype=np.float32)
    out = resample(pts, 41)
    assert len(out) == 41
    gaps = np.linalg.norm(np.diff(out, axis=0), axis=1)
    assert gaps.std() < 0.5, f"uneven spacing, std={gaps.std():.3f}"


# --------------------------------------------------------------------------
# vectorisation
# --------------------------------------------------------------------------


def synthesise_photo() -> tuple[np.ndarray, int]:
    """Draws a diagram, then degrades it the way a phone camera would."""
    board = np.full((900, 1300, 3), 244, dtype=np.uint8)

    ink = (32, 32, 32)
    cv2.rectangle(board, (180, 180), (480, 330), ink, 4)
    cv2.rectangle(board, (820, 180), (1120, 330), ink, 4)
    cv2.ellipse(board, (500, 640), (150, 95), 0, 0, 360, (190, 60, 40), 4)
    cv2.line(board, (480, 255), (820, 255), ink, 4)
    expected_shapes = 4

    # Perspective: the photo is taken from off to one side and slightly above.
    h, w = board.shape[:2]
    src = np.array([[0, 0], [w, 0], [w, h], [0, h]], dtype=np.float32)
    dst = np.array(
        [[70, 40], [w - 30, 95], [w - 90, h - 45], [35, h - 100]], dtype=np.float32
    )
    warped = cv2.warpPerspective(
        board, cv2.getPerspectiveTransform(src, dst), (w, h), borderValue=(120, 120, 120)
    )

    # Illumination gradient plus a glare hotspot — the reason a global threshold
    # cannot work and adaptiveThreshold is used instead.
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    gradient = 0.72 + 0.28 * (xx / w) + 0.14 * (1.0 - yy / h)
    lit = warped.astype(np.float32) * gradient[:, :, None]
    glare = np.exp(-(((xx - w * 0.72) ** 2 + (yy - h * 0.3) ** 2) / (2 * 165.0**2)))
    lit += (glare * 70.0)[:, :, None]
    lit += RNG.normal(0.0, 3.5, lit.shape)

    return np.clip(lit, 0, 255).astype(np.uint8), expected_shapes


def test_deskew_recovers_a_rectangular_board() -> None:
    photo, _ = synthesise_photo()
    flattened, did = deskew(photo)
    assert did, "failed to find the board border"
    # The corrected image should be close to the board's true 1300x900 aspect.
    aspect = flattened.shape[1] / flattened.shape[0]
    assert 1.2 < aspect < 1.75, f"aspect {aspect:.2f} suggests a bad warp"


def test_ink_extraction_survives_glare_and_gradient() -> None:
    photo, _ = synthesise_photo()
    mask = extract_ink(photo)
    coverage = float((mask > 0).mean())
    # Strokes are thin: a few percent of pixels. Much more means the glare or the
    # shadowed corner was thresholded in as ink.
    assert 0.002 < coverage < 0.08, f"implausible ink coverage {coverage:.4f}"


def test_vectorize_recovers_the_diagram() -> None:
    photo, expected = synthesise_photo()
    shapes, deskewed, traced = vectorize(photo, do_deskew=True, max_dim=1400)

    assert deskewed
    assert traced == expected, f"expected {expected} strokes, traced {traced}"

    counts: dict[str, int] = {}
    for spec in shapes:
        counts[spec.kind] = counts.get(spec.kind, 0) + 1

    # The drawn diagram is two boxes, an ellipse and a connector. All four must
    # come back as the right primitive, with nothing spurious alongside.
    assert counts == {"rectangle": 2, "ellipse": 1, "line": 1}, f"got {counts}"

    boxes = sorted((s for s in shapes if s.kind == "rectangle"), key=lambda s: s.x)
    for box in boxes:
        # Source boxes are 300x150; after downscale and the deskew inset the
        # expected size is ~285x140. Allow 15% before calling it a bad fit.
        assert 240 < box.width < 330, f"box width {box.width:.0f} off"
        assert 115 < box.height < 165, f"box height {box.height:.0f} off"
    assert boxes[1].x - boxes[0].x > 400, "boxes should be far apart"

    # Every shape must carry usable geometry, or the client cannot place it.
    for spec in shapes:
        assert spec.width >= 0 and spec.height >= 0
        if spec.kind == "freedraw":
            assert spec.points, "freedraw fallback must include its points"
        assert spec.stroke_color and spec.stroke_color.startswith("#")


def test_skeleton_tracing_resolves_t_junctions() -> None:
    """Two boxes joined by a connector must come back as three strokes.

    This is the case the tracer is built around. The connector lands on the side
    of each box, making a T; the box's side has to be reunited across that T
    while the connector stays a separate element. Getting it wrong is not subtle
    in either direction — either every box arrives as four loose sides, or the
    whole diagram arrives as one polyline.
    """
    canvas = np.zeros((400, 900), dtype=np.uint8)
    cv2.rectangle(canvas, (60, 120), (330, 280), 255, 3)
    cv2.rectangle(canvas, (560, 120), (830, 280), 255, 3)
    cv2.line(canvas, (330, 200), (560, 200), 255, 3)

    paths = trace_skeleton(skeletonise(canvas), min_length=30)

    def is_closed(p: np.ndarray) -> bool:
        return float(np.linalg.norm(p[0] - p[-1])) < 8.0

    closed = [p for p in paths if is_closed(p)]
    open_paths = [p for p in paths if not is_closed(p)]

    assert len(closed) == 2, f"expected two closed boxes, got {len(closed)} of {len(paths)}"
    assert len(open_paths) == 1, f"expected one connector, got {len(open_paths)}"

    # No path may span the whole board: that would mean the boxes got chained
    # together through the connector.
    for p in paths:
        span = float(p[:, 0].max() - p[:, 0].min())
        assert span < 800, f"a single stroke spans {span:.0f}px — shapes were fused"


def test_skeleton_tracing_keeps_a_lone_loop_whole() -> None:
    """A shape with no junction at all must not be split by staircase artefacts."""
    canvas = np.zeros((400, 500), dtype=np.uint8)
    cv2.ellipse(canvas, (250, 200), (180, 110), 0, 0, 360, 255, 3)
    paths = trace_skeleton(skeletonise(canvas), min_length=30)
    assert len(paths) == 1, f"ellipse split into {len(paths)} pieces"
    assert float(np.linalg.norm(paths[0][0] - paths[0][-1])) < 8.0, "loop not closed"


def test_decode_rejects_junk() -> None:
    from limn_vision.vectorize import DecodeError

    with pytest.raises(DecodeError):
        decode_image("not base64 at all !!!")
    with pytest.raises(DecodeError):
        decode_image(base64.b64encode(b"still not an image").decode())
