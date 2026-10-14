"""WeTa Snap local card reader — FastAPI over Surya / Tesseract (AI-02, AI-05).

The PWA calls this straight from the browser over localhost or the LAN and
falls back to the cloud reader when /health does not answer.

Privacy is the whole point of running it locally: the image is decoded in
memory, read, and dropped. Nothing is written to disk and no image text is
ever logged.
"""

from __future__ import annotations

import logging
import os
import threading
import time
import uuid
from typing import Any, Literal, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

import engines
from engines import EngineError
from extract import FieldSpec, extract_fields

VERSION = "1.0.0"

# A 1600 px card at ~300 KB is about 400 KB of base64 (SCAN-06); 8 MB is
# generous enough for a raw phone photo and small enough to stay honest.
MAX_BODY_BYTES = int(os.getenv("OCR_MAX_BODY_BYTES", str(8 * 1024 * 1024)))
LANGUAGES = {"en", "de", "fr", "es", "it", "nl", "pt"}

# Starlette has renamed some of these constants; the numbers are the stable thing.
HTTP_413 = 413
HTTP_422 = 422

logging.basicConfig(
    level=os.getenv("OCR_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("wetasnap.ocr")

# Surya holds model state; one card at a time through the engines.
_engine_lock = threading.Lock()


# --------------------------------------------------------------------------
# Contract (mirrors FieldDefinition / FieldValue in apps/web/src/lib/types.ts)
# --------------------------------------------------------------------------


class FieldIn(BaseModel):
    key: str
    label: str = ""
    type: Literal["text", "email", "phone", "link", "choice", "longtext"] = "text"
    options: list[str] = Field(default_factory=list)
    ai_hint: str = ""
    required: bool = False


class ReadRequest(BaseModel):
    image_base64: str
    mime: str = "image/jpeg"
    fields: list[FieldIn] = Field(default_factory=list)
    language: Optional[Literal["en", "de", "fr", "es", "it", "nl", "pt"]] = None


class FieldOut(BaseModel):
    value: str
    confidence: float
    reason: Optional[str] = None


class ReadResponse(BaseModel):
    fields: dict[str, FieldOut]
    engine: Literal["surya", "tesseract"]
    ms: int


class HealthResponse(BaseModel):
    ok: bool
    engines: dict[str, Any]
    version: str


# --------------------------------------------------------------------------
# App
# --------------------------------------------------------------------------

app = FastAPI(
    title="WeTa Snap local card reader",
    version=VERSION,
    description="Reads exhibition business cards on this machine. No image ever touches the disk.",
)

# Phones on the show Wi-Fi hit this from whatever origin the PWA is served on,
# so any origin is allowed. The bearer token below is what actually guards it.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    max_age=86400,
)


@app.middleware("http")
async def limit_body_size(request: Request, call_next):
    """Refuse an oversized card photo before it is read into memory."""
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        return JSONResponse(
            status_code=HTTP_413,
            content={"detail": f"Image too large; the limit is {MAX_BODY_BYTES} bytes."},
        )
    return await call_next(request)


def require_token(request: Request) -> None:
    """Optional bearer check. Off unless OCR_TOKEN is set — see .env.example."""
    expected = os.getenv("OCR_TOKEN", "").strip()
    if not expected:
        return
    header = request.headers.get("authorization", "")
    scheme, _, supplied = header.partition(" ")
    if scheme.lower() != "bearer" or not _constant_time_eq(supplied.strip(), expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Bad or missing token.")


def _constant_time_eq(a: str, b: str) -> bool:
    import hmac

    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """The app pings this to decide whether to use the local reader (AI-05).

    Deliberately unauthenticated and model-free so it answers in milliseconds.
    """
    return HealthResponse(ok=True, engines=engines.engines_status(), version=VERSION)


@app.post("/read", response_model=ReadResponse, dependencies=[Depends(require_token)])
def read(req: ReadRequest) -> ReadResponse:
    """Read one card into the company's own fields (AI-02)."""
    started = time.perf_counter()
    request_id = uuid.uuid4().hex[:8]

    if len(req.image_base64) > MAX_BODY_BYTES:
        raise HTTPException(HTTP_413, "Image too large.")
    if not req.fields:
        raise HTTPException(HTTP_422, "No fields were requested.")

    language = req.language if req.language in LANGUAGES else None

    try:
        image = engines.decode_image(req.image_base64)
    except EngineError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    decoded_ms = (time.perf_counter() - started) * 1000

    try:
        with _engine_lock:
            ocr_started = time.perf_counter()
            result = engines.read_image(image, language)
            ocr_ms = (time.perf_counter() - ocr_started) * 1000
            qr_payload = engines.read_qr(image)
    except EngineError as exc:
        log.error(
            "read id=%s outcome=failed reason=%s ms=%d",
            request_id, exc, (time.perf_counter() - started) * 1000,
        )
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
    finally:
        image.close()  # the only copy of the card, gone

    specs = [
        FieldSpec(
            key=f.key,
            label=f.label,
            type=f.type,
            options=tuple(f.options),
            ai_hint=f.ai_hint,
            required=f.required,
        )
        for f in req.fields
    ]
    extracted = extract_fields(result.lines, specs, language, qr_payload)
    total_ms = int((time.perf_counter() - started) * 1000)

    # Timings and counts only — never the card's text (privacy).
    log.info(
        "read id=%s engine=%s lang=%s lines=%d qr=%s asked=%d filled=%d "
        "decode_ms=%d ocr_ms=%d total_ms=%d",
        request_id, result.engine, language or "-", len(result.lines),
        bool(qr_payload), len(specs), len(extracted),
        int(decoded_ms), int(ocr_ms), total_ms,
    )

    return ReadResponse(
        fields={k: FieldOut(value=v.value, confidence=v.confidence, reason=v.reason) for k, v in extracted.items()},
        engine=result.engine,
        ms=total_ms,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host=os.getenv("OCR_HOST", "0.0.0.0"),
        port=int(os.getenv("OCR_PORT", "8099")),
        reload=False,
    )
