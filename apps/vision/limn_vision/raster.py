"""Normalisation between caller coordinates and the fixed analysis canvas.

Everything downstream assumes a stroke has been mapped into a square canvas of a
known size. Working at a fixed scale means one set of pixel-denominated
constants (morphology kernel sizes, approxPolyDP epsilons, minimum feature
lengths) is valid for a 40 px doodle and a 4000 px diagram alike.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

CANVAS = 256
PAD = 18
#: Drawn stroke width on the analysis canvas. Thick enough that a shaky stroke
#: forms one connected region rather than a dotted line, thin enough that a
#: small shape's interior survives.
STROKE_PX = 3


@dataclass(frozen=True)
class Normalisation:
    """Affine map from caller coordinates onto the analysis canvas."""

    scale: float
    offset_x: float
    offset_y: float

    def to_canvas(self, pts: np.ndarray) -> np.ndarray:
        out = pts.astype(np.float32).copy()
        out[:, 0] = (out[:, 0] - self.offset_x) * self.scale + PAD
        out[:, 1] = (out[:, 1] - self.offset_y) * self.scale + PAD
        return out

    def to_source(self, pts: np.ndarray) -> np.ndarray:
        out = pts.astype(np.float32).copy()
        out[:, 0] = (out[:, 0] - PAD) / self.scale + self.offset_x
        out[:, 1] = (out[:, 1] - PAD) / self.scale + self.offset_y
        return out

    def length_to_source(self, v: float) -> float:
        return v / self.scale


def normalisation_for(pts: np.ndarray) -> Normalisation:
    min_x = float(np.min(pts[:, 0]))
    min_y = float(np.min(pts[:, 1]))
    width = float(np.max(pts[:, 0])) - min_x
    height = float(np.max(pts[:, 1])) - min_y
    span = max(width, height, 1e-6)
    return Normalisation(
        scale=(CANVAS - 2 * PAD) / span,
        offset_x=min_x,
        offset_y=min_y,
    )


def rasterise(pts_canvas: np.ndarray, closed: bool) -> np.ndarray:
    """Renders a polyline into a binary mask.

    Closed strokes are filled rather than outlined. That is the whole reason
    this service can do better than a purely polyline-based recogniser: filling
    collapses a shape that was drawn in three overlapping passes, or whose
    corners overshoot and cross, into a single solid region whose contour is
    exactly the shape the user meant.
    """
    mask = np.zeros((CANVAS, CANVAS), dtype=np.uint8)
    ints = np.round(pts_canvas).astype(np.int32).reshape(-1, 1, 2)

    if closed:
        cv2.fillPoly(mask, [ints], 255)
        # A thin sliver (a very flat shape) can fill to almost nothing; the
        # outline keeps it connected.
        cv2.polylines(mask, [ints], True, 255, STROKE_PX, cv2.LINE_AA)
        cv2.morphologyEx(
            mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8), dst=mask
        )
    else:
        cv2.polylines(mask, [ints], False, 255, STROKE_PX, cv2.LINE_AA)

    return mask


def largest_contour(mask: np.ndarray) -> np.ndarray | None:
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    return max(contours, key=cv2.contourArea)


def aspect_normalise(contour: np.ndarray) -> np.ndarray:
    """Warps a contour so its minimum-area rectangle becomes a fixed square.

    Hu moments are invariant to translation, rotation and *uniform* scale, but
    not to aspect. Without this step a 3:1 rectangle would fail to match a
    square template and get misread as something exotic. Removing rotation and
    aspect first means one template per family covers every instance of it.
    """
    pts = contour.reshape(-1, 2).astype(np.float32)
    (cx, cy), (w, h), angle_deg = cv2.minAreaRect(contour)
    theta = -np.deg2rad(angle_deg)
    cos_t, sin_t = np.cos(theta), np.sin(theta)

    centred = pts - np.array([cx, cy], dtype=np.float32)
    rotated = np.stack(
        [
            centred[:, 0] * cos_t - centred[:, 1] * sin_t,
            centred[:, 0] * sin_t + centred[:, 1] * cos_t,
        ],
        axis=1,
    )
    rotated[:, 0] /= max(w, 1e-6)
    rotated[:, 1] /= max(h, 1e-6)
    rotated *= 100.0
    rotated += 128.0
    return rotated.reshape(-1, 1, 2).astype(np.float32)
