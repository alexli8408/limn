"""Request/response contracts for the vision service.

Coordinates are always in the *caller's* space (Excalidraw scene units for
stroke endpoints, source pixels for image endpoints). Every internal transform,
normalisation, rasterisation, perspective warp, is undone before responding, so
the web app never has to know how any of this works.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

ShapeKind = Literal[
    "rectangle",
    "ellipse",
    "diamond",
    "triangle",
    "polygon",
    "line",
    "arrow",
    "freedraw",
]

Point = list[float]


class Stroke(BaseModel):
    id: str = Field(max_length=128)
    points: list[Point] = Field(min_length=2, max_length=20_000)


class ShapeMetrics(BaseModel):
    """Diagnostics, surfaced so the client can explain a decision to the user."""

    circularity: float = 0.0
    rect_fill: float = 0.0
    solidity: float = 0.0
    vertices: int = 0
    closed: bool = False
    # cv2.matchShapes distance to the winning Hu-moment template; lower is better.
    template_distance: float = 0.0


class ShapeSpec(BaseModel):
    id: str | None = None
    kind: ShapeKind
    confidence: float = 0.0
    x: float = 0.0
    y: float = 0.0
    width: float = 0.0
    height: float = 0.0
    #: Radians, about the box centre, matches Excalidraw's own convention.
    angle: float = 0.0
    #: Element-local vertices, for path kinds only (line/arrow/polygon/triangle).
    points: list[Point] | None = None
    #: Marker colour recovered from the photograph, snapped to the app palette.
    stroke_color: str | None = None
    metrics: ShapeMetrics = Field(default_factory=ShapeMetrics)


class FitRequest(BaseModel):
    strokes: list[Stroke] = Field(min_length=1, max_length=500)
    #: Below this, the stroke is returned as `freedraw` and left alone.
    min_confidence: float = Field(default=0.55, ge=0.0, le=1.0)


class FitResponse(BaseModel):
    results: list[ShapeSpec]
    recognised: int
    latency_ms: int


class SmoothRequest(BaseModel):
    strokes: list[Stroke] = Field(min_length=1, max_length=500)
    #: Gaussian sigma along the stroke parameter, in samples.
    strength: float = Field(default=1.6, ge=0.1, le=8.0)
    #: Resample to this many points; 0 keeps the original count.
    resample: int = Field(default=0, ge=0, le=4_000)


class SmoothedStroke(BaseModel):
    id: str
    points: list[Point]


class SmoothResponse(BaseModel):
    strokes: list[SmoothedStroke]
    latency_ms: int


class VectorizeRequest(BaseModel):
    #: Base64 PNG/JPEG. Data-URL prefixes are tolerated.
    image_base64: str = Field(min_length=32)
    #: Detect the whiteboard's border and flatten the perspective before tracing.
    deskew: bool = True
    #: Longest side after downscaling. Tracing cost grows with skeleton length.
    max_dim: int = Field(default=1600, ge=320, le=4000)
    #: Drop traced strokes shorter than this many pixels (speckle, marker dust).
    min_stroke_px: int = Field(default=26, ge=4, le=500)
    #: Try to fit primitives, rather than returning raw traced polylines.
    fit_shapes: bool = True


class VectorizeResponse(BaseModel):
    shapes: list[ShapeSpec]
    #: True when a quadrilateral was found and the image was flattened.
    deskewed: bool
    #: Dimensions of the uploaded photo. Reported for logging and for callers
    #: that want to know how much was thrown away; nothing in `shapes` is in
    #: this space.
    source_width: int
    source_height: int
    #: Dimensions of the frame `shapes` are actually in, after downscaling to
    #: max_dim and after any deskew warp. This is the one to scale against when
    #: placing anything alongside the traced shapes.
    traced_width: int
    traced_height: int
    traced_strokes: int
    latency_ms: int


class HealthResponse(BaseModel):
    status: Literal["ok"]
    service: str
    version: str
    opencv: str
    uptime_s: float
    requests_served: int
