/**
 * SCAN-V2 · Pro document scanner engine (DocAligner + plain-canvas warp).
 *
 * The classic scanner (lib/scan.ts) crops axis-aligned and never warps
 * perspective. This engine does the CamScanner-style path instead: find the
 * card's four corners with a small ONNX model (lib/docAligner.ts), flatten the
 * perspective with our own homography, then hand the flat card to the SAME
 * clean-up (`autoEnhance`) and the SAME reading flow as the classic scanner.
 *
 * Geometry is ours on purpose: the warp is a dozen lines of bilinear sampling,
 * which keeps OpenCV (8 MB of CDN JavaScript, unreachable offline) out of the
 * app entirely. Everything in this file that is not canvas work is pure and
 * unit-tested.
 */
import { reportError } from './errors';

export interface Pt { x: number; y: number }
/** Card corners in reading order: top-left, top-right, bottom-right, bottom-left. */
export interface Quad { tl: Pt; tr: Pt; br: Pt; bl: Pt }

export type EngineState = 'idle' | 'loading' | 'ready' | 'error';

let state: EngineState = 'idle';
const listeners = new Set<(s: EngineState) => void>();

export const engineState = () => state;
const setState = (s: EngineState) => { state = s; listeners.forEach((l) => l(s)); };
export const onEngineState = (l: (s: EngineState) => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};

/** Loads the detector once and tracks it for the UI. Retries after a failure. */
async function ensureEngine(): Promise<void> {
  if (state === 'ready') return;
  if (state !== 'loading') setState('loading');
  const { loadAligner } = await import('./docAligner');
  try {
    await loadAligner();
    setState('ready');
  } catch (e) {
    // lib/docAligner drops its cached promise on failure, so the next call retries.
    setState('error');
    void reportError(e, { action: 'Scanning a card with the Pro scanner', where: 'scanEngine › ensureEngine' });
    throw e;
  }
}

/** Warm the model in the background while the person aims the camera. */
export function warmEngine() {
  void ensureEngine().catch(() => { /* the screen surfaces the error state */ });
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

/** Output pixels for the warp: card proportions, long side 2000 (matches SCAN-06). Pure. */
export function outputSizeFor(q: Quad): { w: number; h: number } {
  const wPts = Math.max(dist(q.tl, q.tr), dist(q.bl, q.br));
  const hPts = Math.max(dist(q.tl, q.bl), dist(q.tr, q.br));
  const k = 2000 / Math.max(1, Math.max(wPts, hPts));
  return { w: Math.max(2, Math.round(wPts * k)), h: Math.max(2, Math.round(hPts * k)) };
}

/**
 * Orders four unordered vertices as tl/tr/br/bl (sums-and-differences:
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

// ------------------------------------------------------------ pure warp

/**
 * Homography that maps the `w`×`h` output rectangle onto the quad in the source
 * image, as 8 row-major coefficients [a b c d e f g h]:
 *   u = (a x + b y + c) / (g x + h y + 1),  v = (d x + e y + f) / (g x + h y + 1)
 * Null when the quad is degenerate. Pure: unit-tested.
 */
export function homography(q: Quad, w: number, h: number): number[] | null {
  const dst: Array<[number, number]> = [[0, 0], [w, 0], [w, h], [0, h]];
  const src = [q.tl, q.tr, q.br, q.bl];
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = dst[i]!;
    const { x: u, y: v } = src[i]!;
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  }
  // Gaussian elimination with partial pivoting on the 8×9 augmented matrix.
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r]![col]!) > Math.abs(A[pivot]![col]!)) pivot = r;
    const p = A[pivot]![col]!;
    if (Math.abs(p) < 1e-9) return null;
    [A[col], A[pivot]] = [A[pivot]!, A[col]!];
    const row = A[col]!;
    for (let k = col; k <= 8; k++) row[k] = row[k]! / p;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r]![col]!;
      if (!f) continue;
      for (let k = col; k <= 8; k++) A[r]![k] = A[r]![k]! - f * row[k]!;
    }
  }
  return A.map((row) => row[8]!);
}

/**
 * Perspective warps `src` (already at `sw`×`sh`) so the quad fills a `w`×`h`
 * canvas. Bilinear sampling with edge clamping — no OpenCV, no WebGL.
 * Pure aside from the returned ImageData. Unit-tested.
 */
export function warpPixels(
  src: ImageData, sw: number, sh: number, q: Quad, w: number, h: number,
): ImageData {
  const m = homography(q, w, h);
  const out = new ImageData(w, h);
  const s = src.data;
  const d = out.data;
  if (!m) return out;
  const [a, b, c, e, f, g2, i, j] = m as [number, number, number, number, number, number, number, number];
  for (let y = 0; y < h; y++) {
    const py = y + 0.5;
    for (let x = 0; x < w; x++) {
      const px = x + 0.5;
      const den = i * px + j * py + 1;
      if (Math.abs(den) < 1e-12) continue;
      const u = Math.min(sw - 1, Math.max(0, (a * px + b * py + c) / den));
      const v = Math.min(sh - 1, Math.max(0, (e * px + f * py + g2) / den));
      const x0 = Math.floor(u);
      const y0 = Math.floor(v);
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const fx = u - x0;
      const fy = v - y0;
      const o = (y * w + x) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const p00 = s[(y0 * sw + x0) * 4 + ch]!;
        const p10 = s[(y0 * sw + x1) * 4 + ch]!;
        const p01 = s[(y1 * sw + x0) * 4 + ch]!;
        const p11 = s[(y1 * sw + x1) * 4 + ch]!;
        d[o + ch] = (p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------ model calls

/**
 * Finds the card in a frame. Returns corners in the frame's pixel space, or
 * null when nothing believable is there. Never throws for "no card"; throws
 * only when the detector cannot load at all.
 */
export async function detectCard(src: CanvasImageSource, sw: number, sh: number): Promise<Quad | null> {
  await ensureEngine();
  const { detectCorners } = await import('./docAligner');
  const found = await detectCorners(src, sw, sh);
  if (!found) return null;
  // The model's channel order is fixed, but re-deriving order from geometry makes
  // a rotated or mirrored frame harmless.
  const ordered = orderQuadPoints([found.tl, found.tr, found.br, found.bl]);
  return quadIsSane(ordered, sw, sh) ? ordered : null;
}

/**
 * Warps the quad flat (perspective correction). Uses the given corners when the
 * editor already has them — that path needs no model at all — otherwise detects.
 * Returns null when there is no believable card.
 */
export async function extractCard(
  src: CanvasImageSource, sw: number, sh: number, corners?: Quad | null,
): Promise<{ canvas: HTMLCanvasElement; quad: Quad } | null> {
  let quad = corners ?? null;
  if (!quad) quad = await detectCard(src, sw, sh);
  if (!quad || !quadIsSane(quad, sw, sh)) return null;
  const { w, h } = outputSizeFor(quad);
  const full = document.createElement('canvas');
  full.width = sw;
  full.height = sh;
  const fctx = full.getContext('2d', { willReadFrequently: true });
  if (!fctx) return null;
  fctx.drawImage(src, 0, 0, sw, sh);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.putImageData(warpPixels(fctx.getImageData(0, 0, sw, sh), sw, sh, quad, w, h), 0, 0);
  return { canvas, quad };
}
