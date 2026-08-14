"""Limn vision service.

A small FastAPI app on Render that does the computer-vision work the browser
cannot: OpenCV contour fitting for strokes too messy for the client-side
recogniser, and turning a photograph of a physical whiteboard into editable
elements.

Deployment shape worth knowing about: this runs on a Render free instance, which
is put to sleep after fifteen minutes idle and takes roughly fifty seconds to
cold start. UptimeRobot pings /health every five minutes to prevent that, which
is why /health is the one route that skips authentication.
"""

from __future__ import annotations

import logging
import os
import time
from collections import deque
from contextlib import asynccontextmanager
from typing import Annotated

import cv2
import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException, Response, status
from fastapi.middleware.cors import CORSMiddleware

from limn_vision import __version__
from limn_vision.schemas import (
    FitRequest,
    FitResponse,
    HealthResponse,
    ShapeSpec,
    SmoothedStroke,
    SmoothRequest,
    SmoothResponse,
    VectorizeRequest,
    VectorizeResponse,
)
from limn_vision.shapes import fit_polyline
from limn_vision.smooth import smooth_stroke
from limn_vision.vectorize import DecodeError, decode_image, vectorize

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)-7s %(name)s %(message)s",
)
log = logging.getLogger("limn.vision")

API_KEY = os.getenv("VISION_API_KEY", "")
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "http://localhost:3000").split(",")
    if origin.strip()
]

# OpenCV defaults to one thread per core. On Render's free tier that oversubscribes
# a shared vCPU and makes latency wildly variable under any concurrency at all.
cv2.setNumThreads(int(os.getenv("OPENCV_THREADS", "2")))


class Telemetry:
    """In-process latency samples, exposed at /metrics.

    Deliberately not Prometheus: a free Render instance is a single process with
    no scrape target attached, and a bounded ring buffer answers the only
    question actually being asked, which is what the p50 and p95 are.
    """

    def __init__(self, window: int = 512) -> None:
        self.started = time.monotonic()
        self.requests = 0
        self.errors = 0
        self.samples: dict[str, deque[float]] = {}
        self.window = window

    def record(self, route: str, ms: float) -> None:
        self.requests += 1
        self.samples.setdefault(route, deque(maxlen=self.window)).append(ms)

    def snapshot(self) -> dict[str, object]:
        out: dict[str, object] = {
            "uptime_s": round(time.monotonic() - self.started, 1),
            "requests": self.requests,
            "errors": self.errors,
            "opencv": cv2.__version__,
        }
        for route, values in self.samples.items():
            if not values:
                continue
            ordered = sorted(values)
            out[route] = {
                "n": len(ordered),
                "p50_ms": round(ordered[len(ordered) // 2], 2),
                "p95_ms": round(ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))], 2),
                "max_ms": round(ordered[-1], 2),
            }
        return out


telemetry = Telemetry()


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Import-time work (building the Hu-moment templates) already happened; this
    # just makes the cold-start cost visible in the logs.
    log.info(
        "vision service ready | opencv=%s threads=%s origins=%s auth=%s",
        cv2.__version__,
        cv2.getNumThreads(),
        ALLOWED_ORIGINS,
        "on" if API_KEY else "OFF",
    )
    if not API_KEY:
        log.warning("VISION_API_KEY is unset, every endpoint is publicly callable")
    yield


app = FastAPI(
    title="Limn Vision",
    version=__version__,
    summary="OpenCV stroke fitting and whiteboard photo vectorisation.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["content-type", "x-limn-key"],
)


def require_key(x_limn_key: Annotated[str | None, Header()] = None) -> None:
    """Shared-secret gate.

    The service is reachable from anywhere on the public internet, and image
    vectorisation is expensive enough to be worth abusing. Only the Next.js
    server-side routes hold the key, so it never reaches a browser.
    """
    if not API_KEY:
        return
    if x_limn_key != API_KEY:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid or missing X-Limn-Key"
        )


Guard = Annotated[None, Depends(require_key)]


@app.api_route("/health", methods=["GET", "HEAD"], response_model=HealthResponse)
def health() -> HealthResponse:
    """Unauthenticated on purpose, this is UptimeRobot's keepalive target.

    HEAD as well as GET. Starlette adds HEAD to any GET route automatically, but
    FastAPI's @app.get does not, so uptime checkers that probe with HEAD (which
    UptimeRobot does by default) were getting 405 and reading the service as
    down. It fell back to GET so the keepalive still worked, but the monitor was
    logging a failure on every cycle.
    """
    return HealthResponse(
        status="ok",
        service="limn-vision",
        version=__version__,
        opencv=cv2.__version__,
        uptime_s=round(time.monotonic() - telemetry.started, 1),
        requests_served=telemetry.requests,
    )


@app.get("/metrics")
def metrics(_: Guard) -> dict[str, object]:
    return telemetry.snapshot()


@app.post("/v1/strokes/fit", response_model=FitResponse)
def fit_strokes(payload: FitRequest, _: Guard) -> FitResponse:
    """Fits primitives to a batch of strokes."""
    started = time.perf_counter()
    results: list[ShapeSpec] = []

    for stroke in payload.strokes:
        points = np.asarray(stroke.points, dtype=np.float32)
        if points.ndim != 2 or points.shape[1] < 2:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"stroke {stroke.id}: points must be [x, y] pairs",
            )
        # Excalidraw freedraw points can carry a third pressure component.
        results.append(
            fit_polyline(points[:, :2], stroke_id=stroke.id, min_confidence=payload.min_confidence)
        )

    elapsed = (time.perf_counter() - started) * 1000
    telemetry.record("fit", elapsed)
    return FitResponse(
        results=results,
        recognised=sum(1 for r in results if r.kind != "freedraw"),
        latency_ms=int(elapsed),
    )


@app.post("/v1/strokes/smooth", response_model=SmoothResponse)
def smooth_strokes(payload: SmoothRequest, _: Guard) -> SmoothResponse:
    started = time.perf_counter()
    out: list[SmoothedStroke] = []

    for stroke in payload.strokes:
        points = np.asarray(stroke.points, dtype=np.float32)[:, :2]
        smoothed = smooth_stroke(points, sigma=payload.strength, resample_to=payload.resample)
        out.append(
            SmoothedStroke(
                id=stroke.id,
                points=[[round(float(p[0]), 2), round(float(p[1]), 2)] for p in smoothed],
            )
        )

    elapsed = (time.perf_counter() - started) * 1000
    telemetry.record("smooth", elapsed)
    return SmoothResponse(strokes=out, latency_ms=int(elapsed))


@app.post("/v1/vectorize", response_model=VectorizeResponse)
def vectorize_image(payload: VectorizeRequest, _: Guard) -> VectorizeResponse:
    """Photograph of a whiteboard to editable elements."""
    started = time.perf_counter()
    try:
        image = decode_image(payload.image_base64)
    except DecodeError as exc:
        telemetry.errors += 1
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc

    height, width = image.shape[:2]
    shapes, deskewed, traced = vectorize(
        image,
        do_deskew=payload.deskew,
        max_dim=payload.max_dim,
        min_stroke_px=payload.min_stroke_px,
        fit_shapes=payload.fit_shapes,
    )

    elapsed = (time.perf_counter() - started) * 1000
    telemetry.record("vectorize", elapsed)
    log.info(
        "vectorize %dx%d deskew=%s traced=%d fitted=%d in %dms",
        width,
        height,
        deskewed,
        traced,
        sum(1 for s in shapes if s.kind != "freedraw"),
        int(elapsed),
    )
    return VectorizeResponse(
        shapes=shapes,
        deskewed=deskewed,
        source_width=width,
        source_height=height,
        traced_strokes=traced,
        latency_ms=int(elapsed),
    )


@app.get("/", include_in_schema=False)
def root() -> Response:
    return Response(
        content=f"limn-vision {__version__}, see /docs",
        media_type="text/plain",
    )
