"""Generates the hand-drawn fixture the polish integration test sends to Gemini.

Both halves come out of one definition on purpose. The model is given a picture
AND an element list, and if those two disagree it is being asked to group
strokes it cannot see, which makes the test measure nothing. Here the same
polylines are rasterised and serialised, so the JSON is exactly what the PNG
shows.

The subject is deliberately a picture rather than a diagram: a house, a sun and
a ground line. That is the case Beautify used to refuse outright, so it is the
case worth pinning.

Run from apps/vision so cv2 and numpy are on the path:

    ../../apps/web/lib/ai/fixtures/make-drawing.py
    cd apps/vision && ./.venv/bin/python ../web/lib/ai/fixtures/make-drawing.py
"""

from __future__ import annotations

import json
import math
import pathlib
import random

import cv2
import numpy as np

HERE = pathlib.Path(__file__).parent
W, H = 900, 640
# Fixed so the fixture is reproducible; a test that changes shape between runs
# is a test that cannot be diffed when it starts failing.
RNG = random.Random(7)


def wobble(points, amount=2.4):
    """Nudges every point, so nothing is exactly straight or exactly round."""
    return [(x + RNG.uniform(-amount, amount), y + RNG.uniform(-amount, amount)) for x, y in points]


def line(x1, y1, x2, y2, steps=14):
    return wobble([
        (x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps) for i in range(steps + 1)
    ])


def circle(cx, cy, r, steps=40):
    return wobble([
        (cx + r * math.cos(2 * math.pi * i / steps), cy + r * math.sin(2 * math.pi * i / steps))
        for i in range(steps + 1)
    ], amount=3.0)


STROKES: dict[str, list[tuple[float, float]]] = {
    # The house: four walls drawn as separate strokes, the way a person draws it.
    "wall-left": line(220, 300, 220, 470),
    "wall-right": line(430, 296, 430, 470),
    "wall-top": line(220, 300, 430, 296),
    "wall-bottom": line(220, 470, 430, 470),
    # A roof, two strokes meeting at a peak.
    "roof-left": line(210, 300, 325, 205),
    "roof-right": line(325, 205, 440, 300),
    # A door, slightly off square.
    "door-left": line(300, 380, 300, 470),
    "door-right": line(350, 384, 350, 470),
    "door-top": line(300, 380, 350, 384),
    # The sun, one closed stroke and three rays.
    "sun": circle(700, 180, 62),
    "ray-a": line(700, 90, 700, 55),
    "ray-b": line(790, 180, 828, 180),
    "ray-c": line(766, 114, 792, 88),
    # Ground.
    "ground": line(90, 500, 830, 504, steps=30),
}


def main() -> None:
    canvas = np.full((H, W, 3), 255, dtype=np.uint8)
    for points in STROKES.values():
        pts = np.array([[int(round(x)), int(round(y))] for x, y in points], dtype=np.int32)
        cv2.polylines(canvas, [pts], False, (30, 30, 30), 3, cv2.LINE_AA)

    cv2.imwrite(str(HERE / "hand-drawn.png"), canvas)

    # Excalidraw stores x,y as the position of the first point and every other
    # point as an offset from it, so the JSON has to be written the same way or
    # the elements describe a different picture from the one in the PNG.
    elements = []
    for index, (name, points) in enumerate(STROKES.items()):
        xs = [x for x, _ in points]
        ys = [y for _, y in points]
        x0, y0 = min(xs), min(ys)
        elements.append({
            "id": name,
            "type": "freedraw",
            "x": round(x0, 1),
            "y": round(y0, 1),
            "width": round(max(xs) - x0, 1),
            "height": round(max(ys) - y0, 1),
            "angle": 0,
            "strokeColor": "#1e1e1e",
            "backgroundColor": "transparent",
            "version": 1,
            "versionNonce": 1000 + index,
            "isDeleted": False,
            "points": [[round(x - x0, 1), round(y - y0, 1)] for x, y in points],
        })

    # Opaque ids, deliberately.
    #
    # The strokes are defined above under names like "wall-left" and "sun"
    # because a human has to maintain this file. Shipping those names in the
    # JSON would hand the model the answer: it could group the drawing perfectly
    # by reading the ids and never look at the picture, and the integration test
    # would pass for entirely the wrong reason. Excalidraw's real ids are random,
    # so the fixture uses random-looking ones too and the grouping has to come
    # from the geometry and the image.
    #
    # Seeded from the same RNG, so the mapping is stable across regenerations.
    alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    for element in elements:
        element["id"] = "".join(RNG.choice(alphabet) for _ in range(21))

    (HERE / "hand-drawn.json").write_text(json.dumps(elements, indent=2) + "\n")
    print(f"wrote hand-drawn.png ({W}x{H}) and hand-drawn.json ({len(elements)} strokes)")
    print("ids are opaque so the model cannot group by reading them")


if __name__ == "__main__":
    main()
