/**
 * SCAN-V2 · Pro document scanner engine (jscanify + OpenCV).
 *
 * The classic scanner (lib/scan.ts) crops axis-aligned and never warps perspective.
 * This engine does the CamScanner-style path instead: find the card's four corners,
 * warp the perspective flat with jscanify's `extractPaper`, then hand the flat card
 * to the SAME clean-up (`autoEnhance`) and the SAME reading flow
 * (local OCR → cloud → on-device) as the classic scanner.
 *
 * Detection is two-stage, because jscanify alone takes the *biggest* contour —
 * on a busy background (hand, ceiling lights, furniture) that is rarely the card:
 * 1. quadrilateral search: approximate every contour to a polygon, keep convex
 *    4-point quads, and score each by real edge support along its perimeter
 *    (sampled on the Canny map), card-like proportions and size;
 * 2. jscanify's own biggest-contour quad competes as one more candidate with the
 *    same scoring, so a clean table-top still detects exactly as before.
 * The best quad wins only when it is genuinely supported — otherwise null, and
 * the UI keeps guiding instead of auto-capturing garbage.
 *
 * Weight discipline (§8.1): neither jscanify's wrapper (~8 KB) nor OpenCV (~8 MB) may
 * enter the first download. Both load lazily, only when the Pro scanner opens:
 * the wrapper via a dynamic import (its own chunk, cached by the PWA) and OpenCV
 * via a `<script>` from the CDN (never bundled, never precached — it would blow
 * the 2 MB installed budget on its own). First open needs internet once; after
 * that the browser cache serves it. Offline on first open falls back to /scan.
 */

export interface Pt { x: number; y: number }
/** Card corners in reading order: top-left, top-right, bottom-right, bottom-left. */
export interface Quad { tl: Pt; tr: Pt; br: Pt; bl: Pt }

export type EngineState = 'idle' | 'loading' | 'ready' | 'error';

const OPENCV_URL = 'https://docs.opencv.org/4.7.0/opencv.js';
const LOAD_TIMEOUT_MS = 45_000;
/** Live detection runs on a thumbnail this wide — fast enough for 2 fps on phones. */
export const DETECT_W = 320;

/** Minimal shape of the jscanify browser build (jscanify/client). */
export interface JScanify {
  findPaperContour(img: unknown): { delete(): void } | null;
  getCornerPoints(contour: unknown): {
    topLeftCorner?: Pt; topRightCorner?: Pt; bottomLeftCorner?: Pt; bottomRightCorner?: Pt;
  };
  highlightPaper(image: CanvasImageSource, options?: { color?: string; thickness?: number }): HTMLCanvasElement;
  extractPaper(
    image: CanvasImageSource, resultWidth: number, resultHeight: number,
    cornerPoints?: { topLeftCorner: Pt; topRightCorner: Pt; bottomLeftCorner: Pt; bottomRightCorner: Pt },
  ): HTMLCanvasElement | null;
}

let cvPromise: Promise<void> | null = null;
let scannerPromise: Promise<JScanify> | null = null;
let state: EngineState = 'idle';
const listeners = new Set<(s: EngineState) => void>();

export const engineState = () => state;
const setState = (s: EngineState) => { state = s; listeners.forEach((l) => l(s)); };
export const onEngineState = (l: (s: EngineState) => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};

const getCv = (): any => (window as unknown as { cv?: any }).cv;

/** Loads OpenCV once and waits until its runtime really answers. */
function loadOpenCv(): Promise<void> {
  if (!cvPromise) {
    setState('loading');
    cvPromise = new Promise<void>((resolve, reject) => {
      const fail = (e: unknown) => {
        setState('error');
        reject(e instanceof Error ? e : new Error('The scanner engine could not load.'));
      };
      try {
        const cv = getCv();
        if (cv?.Mat && cv?.imread) { setState('ready'); resolve(); return; }
        if (document.querySelector(`script[data-opencv]`)) {
          // Another attempt is already fetching — just wait for it.
          waitForCv().then(resolve, fail);
          return;
        }
        const s = document.createElement('script');
        s.src = OPENCV_URL;
        s.async = true;
        s.dataset.opencv = '1';
        const timer = setTimeout(() => fail(new Error('The scanner engine took too long to load. Check your connection and try again.')), LOAD_TIMEOUT_MS);
        s.onload = () => {
          // The script tag loads the Emscripten runtime; the API arrives a moment later.
          waitForCv().then(
            () => { clearTimeout(timer); setState('ready'); resolve(); },
            (e) => { clearTimeout(timer); fail(e); },
          );
        };
        s.onerror = () => { clearTimeout(timer); fail(new Error('The scanner engine could not be downloaded. Check your connection and try again.')); };
        document.head.appendChild(s);
      } catch (e) { fail(e); }
    });
    // A failure must be retryable (airplane mode toggled back on, …).
    void cvPromise.catch(() => { cvPromise = null; scannerPromise = null; });
  }
  return cvPromise;
}

function waitForCv(): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const cv = getCv();
      if (cv?.Mat && cv?.imread && cv?.findContours) { resolve(); return; }
      if (Date.now() - t0 > 20_000) { reject(new Error('The scanner engine started but never became ready. Reload and try again.')); return; }
      setTimeout(tick, 60);
    };
    tick();
  });
}

/** The jscanify wrapper chunk loads only here — never in the first download. */
async function loadScanner(): Promise<JScanify> {
  if (!scannerPromise) {
    scannerPromise = (async () => {
      await loadOpenCv();
      const mod = (await import('jscanify/client')) as unknown as
        { default?: new () => JScanify } & { jscanify?: new () => JScanify };
      const Ctor = mod.default ?? (mod as unknown as new () => JScanify);
      if (typeof Ctor !== 'function') throw new Error('The scanner engine loaded an unexpected module.');
      return new Ctor();
    })();
    void scannerPromise.catch(() => { scannerPromise = null; });
  }
  return scannerPromise;
}

/** Warm the engine in the background while the person aims the camera. */
export function warmEngine() {
  void loadScanner().catch(() => { /* the screen surfaces the error state */ });
}

// ------------------------------------------------------------ pure geometry

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Shoelace area — the card's footprint in the frame. Pure: unit-tested. */
export function quadArea(q: Quad): number {
  const { tl, tr, br, bl } = q;
  return Math.abs(
    (tl.x * tr.y + tr.x * br.y + br.x * bl.y + bl.x * tl.y
      - tr.x * tl.y - br.x * tr.y - bl.x * br.y - tl.x * bl.y) / 2,
  );
}

const cross = (a: Pt, b: Pt, c: Pt) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

/**
 * A believable card: four finite corners, convex, covering 4–98% of the frame,
 * no side shorter than 3% of the frame's long side (rules out edge specks).
 * Pure: unit-tested.
 */
export function quadIsSane(q: Quad, w: number, h: number): boolean {
  const pts = [q.tl, q.tr, q.br, q.bl];
  if (!pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return false;
  const signs = [cross(q.tl, q.tr, q.br), cross(q.tr, q.br, q.bl), cross(q.br, q.bl, q.tl), cross(q.bl, q.tl, q.tr)];
  if (signs.some((s) => s === 0) || !(signs.every((s) => s > 0) || signs.every((s) => s < 0))) return false;
  const frame = w * h;
  const area = quadArea(q);
  if (area < frame * 0.04 || area > frame * 0.98) return false;
  const minSide = Math.max(w, h) * 0.03;
  const sides = [dist(q.tl, q.tr), dist(q.tr, q.br), dist(q.br, q.bl), dist(q.bl, q.tl)];
  return sides.every((s) => s >= minSide);
}

/** Every corner moved less than `eps` (fraction of the frame diagonal). Pure: unit-tested. */
export function quadsClose(a: Quad, b: Quad, eps: number, w: number, h: number): boolean {
  const tol = Math.hypot(w, h) * eps;
  const pairs: Array<[Pt, Pt]> = [[a.tl, b.tl], [a.tr, b.tr], [a.br, b.br], [a.bl, b.bl]];
  return pairs.every(([p, q]) => dist(p, q) <= tol);
}

export const scaleQuad = (q: Quad, sx: number, sy: number): Quad => ({
  tl: { x: q.tl.x * sx, y: q.tl.y * sy },
  tr: { x: q.tr.x * sx, y: q.tr.y * sy },
  br: { x: q.br.x * sx, y: q.br.y * sy },
  bl: { x: q.bl.x * sx, y: q.bl.y * sy },
});

/** Output pixels for the warp: card proportions, long side 1600 (matches SCAN-06). Pure. */
export function outputSizeFor(q: Quad): { w: number; h: number } {
  const wPts = Math.max(dist(q.tl, q.tr), dist(q.bl, q.br));
  const hPts = Math.max(dist(q.tl, q.bl), dist(q.tr, q.br));
  const k = 1600 / Math.max(1, Math.max(wPts, hPts));
  return { w: Math.max(2, Math.round(wPts * k)), h: Math.max(2, Math.round(hPts * k)) };
}

/**
 * Orders four unordered contour vertices as tl/tr/br/bl (sums-and-differences:
 * tl minimises x+y, br maximises it, tr minimises y−x, bl maximises it).
 * Pure: unit-tested.
 */
export function orderQuadPoints(pts: [Pt, Pt, Pt, Pt]): Quad {
  const sum = pts.map((p) => p.x + p.y);
  const dif = pts.map((p) => p.y - p.x);
  const at = (arr: number[], pick: (a: number, b: number) => boolean) =>
    pts[arr.reduce((bi, v, i) => (pick(v, arr[bi]!) ? i : bi), 0)]!;
  return {
    tl: at(sum, (a, b) => a < b),
    br: at(sum, (a, b) => a > b),
    tr: at(dif, (a, b) => a < b),
    bl: at(dif, (a, b) => a > b),
  };
}

/** Long side over short side of the quad (orientation-free). Pure: unit-tested. */
export function quadAspect(q: Quad): number {
  const wPts = (dist(q.tl, q.tr) + dist(q.bl, q.br)) / 2;
  const hPts = (dist(q.tl, q.bl) + dist(q.tr, q.br)) / 2;
  return Math.max(wPts, hPts) / Math.max(1, Math.min(wPts, hPts));
}

/**
 * Fraction of the quad's perimeter actually backed by an edge pixel (3×3
 * neighbourhood on the Canny map, sampled every 2 px). A real card boundary
 * scores high; a phantom quad across clutter scores low — even when both are
 * convex and card-sized. Pure: unit-tested.
 */
export function edgeSupport(q: Quad, edge: Uint8Array | Uint8ClampedArray, w: number, h: number): number {
  const segs: Array<[Pt, Pt]> = [[q.tl, q.tr], [q.tr, q.br], [q.br, q.bl], [q.bl, q.tl]];
  let hits = 0;
  let samples = 0;
  for (const [a, b] of segs) {
    const len = dist(a, b);
    const n = Math.max(1, Math.floor(len / 2));
    for (let i = 0; i <= n; i++) {
      const x = Math.round(a.x + ((b.x - a.x) * i) / n);
      const y = Math.round(a.y + ((b.y - a.y) * i) / n);
      samples++;
      let hit = false;
      for (let dy = -1; dy <= 1 && !hit; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (edge[yy * w + xx]) { hit = true; break; }
        }
      }
      if (hit) hits++;
    }
  }
  return samples ? hits / samples : 0;
}

/** A quad needs this much of its outline on real edges (occlusion-tolerant). */
export const QUAD_MIN_SUPPORT = 0.3;
/** …and this total score to win. */
export const QUAD_MIN_SCORE = 0.42;

/**
 * 0–1 score: mostly edge support, then card-like proportions (peaks at ID-1
 * 1.586, tolerant either orientation), then a preference for reasonably large.
 * Pure: unit-tested.
 */
export function scoreQuad(q: Quad, w: number, h: number, edge: Uint8Array | Uint8ClampedArray): number {
  const support = edgeSupport(q, edge, w, h);
  const aspectScore = Math.exp(-(((quadAspect(q) - 1.62) / 0.8) ** 2));
  const areaScore = Math.min(1, quadArea(q) / (w * h) / 0.25);
  return 0.65 * support + 0.2 * aspectScore + 0.15 * areaScore;
}

// ------------------------------------------------------------ jscanify + OpenCV calls

function toQuad(raw: { topLeftCorner?: Pt; topRightCorner?: Pt; bottomLeftCorner?: Pt; bottomRightCorner?: Pt }): Quad | null {
  if (!raw.topLeftCorner || !raw.topRightCorner || !raw.bottomLeftCorner || !raw.bottomRightCorner) return null;
  return { tl: raw.topLeftCorner, tr: raw.topRightCorner, br: raw.bottomRightCorner, bl: raw.bottomLeftCorner };
}

/**
 * Best supported quad on the thumbnail: polygon-approximated quads plus
 * jscanify's biggest-contour quad, all scored on the same Canny map.
 * Returns null when nothing is genuinely supported. Frees every Mat it makes.
 */
function bestQuad(cv: any, scanner: JScanify, img: any, tw: number, th: number): Quad | null {
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.cvtColor(img, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    cv.Canny(blurred, edges, 75, 200);
    // findContours destroys its input — copy the edge map for scoring first.
    const edge = Uint8Array.from(edges.data as Uint8Array);
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const cands: Quad[] = [];
    const frame = tw * th;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      try {
        const area = cv.contourArea(c);
        if (area < frame * 0.02 || area > frame * 0.97) continue;
        const peri = cv.arcLength(c, true);
        if (peri <= 0) continue;
        const approx = new cv.Mat();
        try {
          cv.approxPolyDP(c, approx, 0.02 * peri, true);
          if (approx.rows !== 4 || !cv.isContourConvex(approx)) continue;
          const d = approx.data32S as Int32Array;
          const q = orderQuadPoints([
            { x: d[0]!, y: d[1]! }, { x: d[2]!, y: d[3]! },
            { x: d[4]!, y: d[5]! }, { x: d[6]!, y: d[7]! },
          ]);
          if (quadIsSane(q, tw, th)) cands.push(q);
        } finally {
          approx.delete();
        }
      } finally {
        c.delete();
      }
    }

    // jscanify's own answer competes as one more candidate — never the only one.
    try {
      const contour = scanner.findPaperContour(img) as unknown as { delete(): void } | null;
      if (contour) {
        try {
          const q = toQuad(scanner.getCornerPoints(contour));
          if (q && quadIsSane(q, tw, th)) cands.push(q);
        } finally {
          try { contour.delete(); } catch { /* best effort */ }
        }
      }
    } catch { /* the polygon search stands on its own */ }

    let best: Quad | null = null;
    let bestScore = QUAD_MIN_SCORE;
    for (const q of cands) {
      if (edgeSupport(q, edge, tw, th) < QUAD_MIN_SUPPORT) continue;
      const s = scoreQuad(q, tw, th, edge);
      if (s > bestScore) { bestScore = s; best = q; }
    }
    return best;
  } finally {
    try { hierarchy.delete(); } catch { /* best effort */ }
    try { contours.delete(); } catch { /* best effort */ }
    try { edges.delete(); } catch { /* best effort */ }
    try { blurred.delete(); } catch { /* best effort */ }
    try { gray.delete(); } catch { /* best effort */ }
  }
}

/** Draws the source onto a thumbnail and finds the card in it — cheap enough for live use. */
async function detectOnThumb(scanner: JScanify, src: CanvasImageSource, sw: number, sh: number): Promise<{ quad: Quad; tw: number; th: number } | null> {
  const k = Math.min(1, DETECT_W / Math.max(sw, sh));
  const tw = Math.max(2, Math.round(sw * k));
  const th = Math.max(2, Math.round(sh * k));
  const t = document.createElement('canvas');
  t.width = tw;
  t.height = th;
  t.getContext('2d')!.drawImage(src, 0, 0, tw, th);
  const cv = getCv();
  const img = cv.imread(t);
  try {
    const quad = bestQuad(cv, scanner, img, tw, th);
    if (!quad) return null;
    return { quad, tw, th };
  } finally {
    try { img.delete(); } catch { /* best effort */ }
  }
}

/**
 * Finds the card in a full-resolution frame. Returns corners in full-resolution
 * pixels, or null when nothing card-shaped is there. Never throws for "no card".
 */
export async function detectCard(src: CanvasImageSource, sw: number, sh: number): Promise<Quad | null> {
  const scanner = await loadScanner();
  const found = await detectOnThumb(scanner, src, sw, sh);
  if (!found) return null;
  return scaleQuad(found.quad, sw / found.tw, sh / found.th);
}

/**
 * Warps the quad flat (perspective correction). Falls back to the caller's
 * corners when detection is off, and returns null when no card is found.
 * Uses `extractPaper` — the warp is the point of this scanner.
 */
export async function extractCard(
  src: CanvasImageSource, sw: number, sh: number, corners?: Quad | null,
): Promise<{ canvas: HTMLCanvasElement; quad: Quad } | null> {
  const scanner = await loadScanner();
  let quad = corners ?? null;
  if (!quad) quad = await detectCard(src, sw, sh);
  if (!quad || !quadIsSane(quad, sw, sh)) return null;
  const { w, h } = outputSizeFor(quad);
  try {
    const canvas = scanner.extractPaper(src, w, h, {
      topLeftCorner: quad.tl, topRightCorner: quad.tr,
      bottomLeftCorner: quad.bl, bottomRightCorner: quad.br,
    });
    if (!canvas) return null;
    return { canvas, quad };
  } catch {
    return null;
  }
}

/**
 * Still-image preview with the detected outline drawn on it (uses
 * `highlightPaper`). For the "look what the scanner sees" step in the editor.
 */
export async function highlightStill(src: CanvasImageSource): Promise<HTMLCanvasElement | null> {
  try {
    const scanner = await loadScanner();
    return scanner.highlightPaper(src, { color: '#059669', thickness: 8 });
  } catch {
    return null;
  }
}
