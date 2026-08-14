"""Freehand stroke smoothing, for strokes the fitter declined to replace.

Not every stroke is a shape. Handwriting, annotation arrows drawn in three
segments, a scribble emphasising something — these should stay themselves, just
tidier. This module removes tremor without removing intent.
"""

from __future__ import annotations

import cv2
import numpy as np


def resample(points: np.ndarray, count: int) -> np.ndarray:
    """Arc-length resampling to exactly `count` points."""
    pts = np.asarray(points, dtype=np.float32).reshape(-1, 2)
    if len(pts) < 2 or count < 2:
        return pts

    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    cumulative = np.concatenate([[0.0], np.cumsum(seg)])
    total = float(cumulative[-1])
    if total <= 1e-6:
        return np.repeat(pts[:1], count, axis=0)

    targets = np.linspace(0.0, total, count)
    return np.stack(
        [
            np.interp(targets, cumulative, pts[:, 0]),
            np.interp(targets, cumulative, pts[:, 1]),
        ],
        axis=1,
    ).astype(np.float32)


def smooth_stroke(points: np.ndarray, sigma: float = 1.6, resample_to: int = 0) -> np.ndarray:
    """Gaussian-smooths a stroke along its parameter.

    Implemented as a 1-D Gaussian blur over the coordinate sequence itself: the
    stroke is treated as a two-row image and handed to cv2.GaussianBlur. That
    reuses a separable, SIMD-optimised kernel instead of hand-rolling a
    convolution, and BORDER_REPLICATE gives the right behaviour at the ends.

    Endpoints are then restored exactly. A smoothed stroke that no longer starts
    where the user put the pen down reads as a glitch, however slight the drift.
    """
    pts = np.asarray(points, dtype=np.float32).reshape(-1, 2)
    if len(pts) < 3 or sigma <= 0:
        return pts

    if resample_to > 0:
        pts = resample(pts, resample_to)

    radius = max(1, int(round(sigma * 2.5)))
    ksize = 2 * radius + 1
    if ksize >= len(pts):
        ksize = max(3, (len(pts) - 1) | 1)

    # Shape (N, 1, 2) so the blur runs down the stroke, not across x against y.
    stack = pts.reshape(-1, 1, 2)
    blurred = cv2.GaussianBlur(
        stack, (1, ksize), sigmaX=0, sigmaY=sigma, borderType=cv2.BORDER_REPLICATE
    ).reshape(-1, 2)

    blurred[0] = pts[0]
    blurred[-1] = pts[-1]
    return blurred
