"""OCR engines: Surya first, Tesseract as the fallback (AI-05).

The Surya models are heavy to load (seconds) and cheap to keep, so they live in
a lazy singleton that is built on the first request and reused for every one
after it. Nothing is ever written to disk — the image only exists in memory.
"""

from __future__ import annotations

import base64
import binascii
import io
import logging
import os
import re
import threading
from dataclasses import dataclass
from html import unescape
from typing import Any, Literal, Optional, Sequence

from extract import Line

log = logging.getLogger("wetasnap.ocr.engines")

EngineName = Literal["surya", "tesseract"]

# The seven languages the app supports -> Tesseract's three-letter codes.
TESSERACT_LANGS: dict[str, str] = {
    "en": "eng", "de": "deu", "fr": "fra",
    "es": "spa", "it": "ita", "nl": "nld", "pt": "por",
}


class EngineError(RuntimeError):
    """No engine could read the image."""


@dataclass
class OcrOutput:
    lines: list[Line]
    engine: EngineName
    width: int
    height: int


# --------------------------------------------------------------------------
# Image decoding
# --------------------------------------------------------------------------


def decode_image(image_base64: str) -> "Any":
    """base64 (with or without a data: prefix) -> RGB PIL image, in memory only."""
    from PIL import Image, ImageOps  # imported late: keeps start-up quick

    payload = image_base64.strip()
    if payload.startswith("data:"):
        _, _, payload = payload.partition(",")
    payload = "".join(payload.split())
    try:
        raw = base64.b64decode(payload, validate=False)
    except (binascii.Error, ValueError) as exc:
        raise EngineError(f"Could not decode the image: {exc}") from exc
    if not raw:
        raise EngineError("The image was empty.")
    try:
        img = Image.open(io.BytesIO(raw))
        img = ImageOps.exif_transpose(img)  # phones photograph cards sideways
        return img.convert("RGB")
    except Exception as exc:  # Pillow raises a family of errors here
        raise EngineError(f"Could not open the image: {exc}") from exc


# --------------------------------------------------------------------------
# Surya
# --------------------------------------------------------------------------


class _SuryaSingleton:
    """Loads Surya once, on first use, and holds it for the process lifetime."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._loaded = False
        self._recognition: Any = None
        self._detection: Any = None
        self._style: str = ""
        self._error: Optional[str] = None

    @property
    def error(self) -> Optional[str]:
        return self._error

    def available(self) -> bool:
        """True if the surya package is importable — without loading the models."""
        import importlib.util

        return importlib.util.find_spec("surya") is not None

    def load(self) -> bool:
        if self._loaded:
            return True
        with self._lock:
            if self._loaded:
                return True
            try:
                self._load_locked()
                self._loaded = True
                self._error = None
                log.info("surya loaded (api=%s)", self._style)
            except Exception as exc:
                self._error = f"{type(exc).__name__}: {exc}"
                log.warning("surya unavailable: %s", self._error)
                return False
        return True

    def _load_locked(self) -> None:
        """Surya has reshaped its API several times; pick the shape by signature."""
        try:
            from surya.recognition import RecognitionPredictor  # type: ignore
            from surya.detection import DetectionPredictor  # type: ignore
        except ImportError:
            self._load_legacy_run_ocr()
            return

        import inspect

        params = inspect.signature(RecognitionPredictor.__call__).parameters

        if "full_page" in params:
            # 0.20+: recognition returns HTML blocks; detection supplies line boxes.
            manager = None
            try:
                from surya.inference import SuryaInferenceManager  # type: ignore

                # lazy=False so the model is warm before the first card arrives.
                manager = SuryaInferenceManager(lazy=False)
            except Exception as exc:  # older builds, or no backend available
                log.debug("surya inference manager not used: %s", exc)
            self._recognition = RecognitionPredictor(manager) if manager else RecognitionPredictor()
            self._detection = DetectionPredictor()
            self._style = "blocks"
            return

        # 0.14 - 0.19: a shared FoundationPredictor feeds recognition.
        try:
            from surya.foundation import FoundationPredictor  # type: ignore

            self._recognition = RecognitionPredictor(FoundationPredictor())
            self._detection = DetectionPredictor()
            self._style = "predictor"
            return
        except ImportError:
            pass

        # 0.6 - 0.13: the predictors construct themselves.
        self._recognition = RecognitionPredictor()
        self._detection = DetectionPredictor()
        self._style = "predictor"

    def _load_legacy_run_ocr(self) -> None:
        """0.4 - 0.5: a loose run_ocr() plus four loaders."""
        from surya.ocr import run_ocr  # type: ignore
        from surya.model.detection.model import (  # type: ignore
            load_model as load_det_model,
            load_processor as load_det_processor,
        )
        from surya.model.recognition.model import load_model as load_rec_model  # type: ignore
        from surya.model.recognition.processor import load_processor as load_rec_processor  # type: ignore

        self._recognition = (run_ocr, load_rec_model(), load_rec_processor())
        self._detection = (load_det_model(), load_det_processor())
        self._style = "run_ocr"

    def read(self, image: Any, language: Optional[str]) -> list[Line]:
        if not self.load():
            raise EngineError(self._error or "Surya is not available.")
        langs = [[language or "en"]]

        if self._style == "run_ocr":
            run_ocr, rec_model, rec_processor = self._recognition
            det_model, det_processor = self._detection
            return _surya_lines(run_ocr([image], langs, det_model, det_processor, rec_model, rec_processor))

        if self._style == "blocks":
            page = self._recognition([image], full_page=True)[0]
            boxes: list[Any] = []
            try:
                boxes = list(self._detection([image])[0].bboxes)
            except Exception as exc:
                # Without detection we still have the block boxes, just coarser.
                log.warning("surya detection unavailable, using block boxes: %s", exc)
            return _lines_from_blocks(page, boxes)

        return _surya_lines(self._call_predictor(image, langs))

    def _call_predictor(self, image: Any, langs: list[list[str]]) -> Any:
        """The predictor signature gained and lost a `langs` argument over time."""
        attempts = (
            lambda: self._recognition([image], det_predictor=self._detection),
            lambda: self._recognition([image], langs, self._detection),
            lambda: self._recognition([image], [None], self._detection),
            lambda: self._recognition([image], det_predictor=self._detection, langs=langs),
        )
        last: Optional[Exception] = None
        for attempt in attempts:
            try:
                return attempt()
            except TypeError as exc:
                last = exc
        raise EngineError(f"Surya rejected every known call shape: {last}")


_BREAK_RE = re.compile(r"(?i)</?(?:br|p|div|li|tr|h[1-6]|section|article)[^>]*>")
_TAG_RE = re.compile(r"<[^>]+>")


def _html_to_lines(markup: str) -> list[str]:
    """Surya 0.20+ hands back a block of HTML; we want its visible lines."""
    text = _BREAK_RE.sub("\n", markup or "")
    text = _TAG_RE.sub("", text)
    return [t.strip() for t in unescape(text).splitlines() if t.strip()]


def _centre_inside(inner: Sequence[float], outer: Sequence[float]) -> bool:
    cx = (float(inner[0]) + float(inner[2])) / 2
    cy = (float(inner[1]) + float(inner[3])) / 2
    return outer[0] <= cx <= outer[2] and outer[1] <= cy <= outer[3]


def _lines_from_blocks(page: Any, det_boxes: Sequence[Any]) -> list[Line]:
    """Pair each recognised line of a block with its detected box.

    The box matters as much as the text here: the field heuristics lean on
    font size and position. When the counts do not line up (detection missed a
    line, or a block wrapped), the block box is sliced into equal bands so the
    reading order survives even though the font sizes go flat.
    """
    boxes = sorted(
        (b for b in det_boxes if getattr(b, "bbox", None)),
        key=lambda b: (round(float(b.bbox[1]), 1), float(b.bbox[0])),
    )
    out: list[Line] = []

    blocks = sorted(getattr(page, "blocks", []) or [], key=lambda b: getattr(b, "reading_order", 0))
    for block in blocks:
        if getattr(block, "skipped", False) or getattr(block, "error", False):
            continue
        texts = _html_to_lines(getattr(block, "html", ""))
        if not texts:
            continue
        raw = getattr(block, "bbox", None) or [0.0, 0.0, 0.0, 0.0]
        bbox = [float(v) for v in raw]
        block_conf = float(getattr(block, "confidence", None) or 0.85)

        inside = [b for b in boxes if _centre_inside(b.bbox, bbox)]
        if len(inside) == len(texts):
            for text, box in zip(texts, inside):
                out.append(
                    Line(
                        text=text,
                        bbox=(float(box.bbox[0]), float(box.bbox[1]), float(box.bbox[2]), float(box.bbox[3])),
                        confidence=float(getattr(box, "confidence", None) or block_conf),
                    )
                )
        else:
            band = (bbox[3] - bbox[1]) / max(1, len(texts))
            for n, text in enumerate(texts):
                out.append(
                    Line(
                        text=text,
                        bbox=(bbox[0], bbox[1] + n * band, bbox[2], bbox[1] + (n + 1) * band),
                        confidence=block_conf,
                    )
                )

    out.sort(key=lambda l: (round(l.top, 1), l.left))
    return out


def _surya_lines(results: Any) -> list[Line]:
    """Surya returns one result per image; each holds text_lines with boxes."""
    out: list[Line] = []
    first = results[0] if isinstance(results, (list, tuple)) and results else results
    text_lines = getattr(first, "text_lines", None) or []
    for tl in text_lines:
        text = (getattr(tl, "text", "") or "").strip()
        if not text:
            continue
        bbox = getattr(tl, "bbox", None) or [0.0, 0.0, 0.0, 0.0]
        confidence = getattr(tl, "confidence", None)
        out.append(
            Line(
                text=text,
                bbox=(float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])),
                confidence=float(confidence) if confidence is not None else 0.8,
            )
        )
    out.sort(key=lambda l: (round(l.top, 1), l.left))
    return out


surya = _SuryaSingleton()


# --------------------------------------------------------------------------
# Tesseract
# --------------------------------------------------------------------------


def _configure_tesseract() -> Any:
    """pytesseract, pointed at the Windows binary if TESSERACT_CMD says where."""
    import pytesseract  # type: ignore

    cmd = os.getenv("TESSERACT_CMD", "").strip()
    if cmd:
        pytesseract.pytesseract.tesseract_cmd = cmd
    return pytesseract


def tesseract_available() -> bool:
    try:
        pytesseract = _configure_tesseract()
        pytesseract.get_tesseract_version()
        return True
    except Exception as exc:
        log.debug("tesseract unavailable: %s", exc)
        return False


def read_with_tesseract(image: Any, language: Optional[str]) -> list[Line]:
    """Word boxes from image_to_data, grouped back into lines."""
    pytesseract = _configure_tesseract()
    from pytesseract import Output  # type: ignore

    lang = TESSERACT_LANGS.get(language or "en", "eng")
    if lang != "eng":
        lang = f"{lang}+eng"  # cards mix a local language with English

    try:
        data = pytesseract.image_to_data(image, lang=lang, output_type=Output.DICT)
    except Exception as exc:
        # A missing language pack should not lose us the card.
        log.warning("tesseract lang=%s failed (%s); retrying with eng", lang, exc)
        data = pytesseract.image_to_data(image, lang="eng", output_type=Output.DICT)

    grouped: dict[tuple[int, int, int, int], list[tuple[str, float, tuple[int, int, int, int]]]] = {}
    for i, word in enumerate(data.get("text", [])):
        word = (word or "").strip()
        if not word:
            continue
        try:
            conf = float(data["conf"][i])
        except (TypeError, ValueError):
            conf = -1.0
        if conf < 0:
            continue
        key = (
            int(data["page_num"][i]), int(data["block_num"][i]),
            int(data["par_num"][i]), int(data["line_num"][i]),
        )
        box = (int(data["left"][i]), int(data["top"][i]), int(data["width"][i]), int(data["height"][i]))
        grouped.setdefault(key, []).append((word, conf / 100.0, box))

    lines: list[Line] = []
    for words in grouped.values():
        if not words:
            continue
        text = " ".join(w for w, _, _ in words).strip()
        if len(text) < 2:
            continue
        x0 = min(b[0] for _, _, b in words)
        y0 = min(b[1] for _, _, b in words)
        x1 = max(b[0] + b[2] for _, _, b in words)
        y1 = max(b[1] + b[3] for _, _, b in words)
        confidence = sum(c for _, c, _ in words) / len(words)
        lines.append(Line(text=text, bbox=(float(x0), float(y0), float(x1), float(y1)), confidence=confidence))

    lines.sort(key=lambda l: (round(l.top, 1), l.left))
    return lines


# --------------------------------------------------------------------------
# QR codes
# --------------------------------------------------------------------------


def read_qr(image: Any) -> Optional[str]:
    """A vCard or URL QR beats any heuristic — it cannot be misread."""
    try:
        from pyzbar.pyzbar import decode as zbar_decode  # type: ignore

        for symbol in zbar_decode(image):
            payload = symbol.data.decode("utf-8", errors="replace").strip()
            if payload:
                return payload
    except Exception as exc:
        log.debug("pyzbar not used: %s", exc)

    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore

        array = cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)
        payload, _points, _straight = cv2.QRCodeDetector().detectAndDecode(array)
        if payload and payload.strip():
            return payload.strip()
    except Exception as exc:
        log.debug("opencv not used: %s", exc)
    return None


def qr_available() -> bool:
    import importlib.util

    return any(importlib.util.find_spec(m) is not None for m in ("pyzbar", "cv2"))


# --------------------------------------------------------------------------
# The engine choice
# --------------------------------------------------------------------------


def engine_preference() -> str:
    value = os.getenv("OCR_ENGINE", "auto").strip().lower()
    return value if value in {"auto", "surya", "tesseract"} else "auto"


def engines_status() -> dict[str, Any]:
    """What /health reports, without loading a single model."""
    return {
        "preference": engine_preference(),
        "surya": {"installed": surya.available(), "loaded": surya._loaded, "error": surya.error},
        "tesseract": {"installed": tesseract_available()},
        "qr": {"installed": qr_available()},
    }


def read_image(image: Any, language: Optional[str] = None) -> OcrOutput:
    """Try the preferred engine, fall back to the other one (AI-05)."""
    preference = engine_preference()
    width, height = image.size
    errors: list[str] = []

    order: Sequence[EngineName]
    if preference == "surya":
        order = ("surya",)
    elif preference == "tesseract":
        order = ("tesseract",)
    else:
        order = ("surya", "tesseract")

    for name in order:
        try:
            if name == "surya":
                if not surya.available():
                    errors.append("surya: not installed")
                    continue
                lines = surya.read(image, language)
            else:
                lines = read_with_tesseract(image, language)
            if lines:
                return OcrOutput(lines=lines, engine=name, width=width, height=height)
            errors.append(f"{name}: no text found")
        except Exception as exc:
            errors.append(f"{name}: {type(exc).__name__}: {exc}")
            log.warning("engine %s failed: %s", name, exc)

    raise EngineError("; ".join(errors) or "No OCR engine is available.")
