/**
 * SCAN-V2 · Pro document scanner engine.
 *
 * The classic scanner (lib/scan.ts) crops axis-aligned and never warps perspective.
 * This engine does the CamScanner-style path instead: the DocAligner model finds the
 * card's four corners (lib/docAligner.ts), we warp the perspective flat ourselves,
 * then hand the flat card to the SAME clean-up (`autoEnhance`) and the SAME reading
 * flow (local OCR → cloud → on-device) as the classic scanner.
 *
 * Geometry is ours on purpose: OpenCV + jscanify meant an 8 MB third-party script
 * from a CDN, which cannot be precached and so broke the offline promise of the Pro
 * scanner. A square-to-quad homography traced backwards over the destination pixels
 * is ~30 lines and exact — affine-per-triangle would leave a seam.
 *
 * Weight (§8.1): detection and warp cost nothing on the first download. The model
 * (4.5 MB) and the ORT runtime load lazily when the Pro scanner opens, both cached
 * by the service worker so a cold, offline launch still scans.
 */
import { inferCorners, warmModel } from './docAligner';

export interface Pt { x: number; y: number }
/** Card corners in reading order: top-left, top-right, bottom-right, bottom-left. */
export interface Quad { tl: Pt; tr: Pt; br: Pt; bl: Pt }

export type EngineState = 'idle' | 'loading' | 'ready' | 'error';

/** Live detection runs on a thumbnail this wide — fast enough for 2 fps on phones. */
export const DETECT_W = 320;

let state: EngineState = 'idle';
const listeners = new Set<(s: EngineState) => void>();

export const engineState = () => state;
const setState = (s: EngineState) => { state = s; listeners.forEach((l) => l(s)); };
export const onEngineState = (l: (s: EngineState) => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};

/** Warm the detector in the background while the person aims the camera. */
export function warmEngine() {
  if (state === 'loading' || state === 'ready') return;
  setState('loading');
  void warmModel().then(
    () => setState('ready'),
    () => setState('error'),
  );
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

// ------------------------------------------------------------ warp

/**
 * Projects the quad flat: every destination pixel is traced back into the source
 * through the square-to-quad homography (Heckbert's closed form) and sampled
 * bilinearly. Whatever falls outside the quad is white, like a page. Pure on RGBA
 * bytes, so the geometry is unit-tested without a canvas.
 */
export function warpPixels(
  src: Uint8ClampedArray, sw: number, sh: number, q: Quad, outW: number, outH: number,
): Uint8ClampedArray<ArrayBuffer> {
  const { tl, tr, br, bl } = q;
  // Unit square (0,0)→tl, (1,0)→tr, (1,1)→br, (0,1)→bl.
  const dx1 = tr.x - br.x;
  const dx2 = bl.x - br.x;
  const dx3 = tl.x - tr.x + br.x - bl.x;
  const dy1 = tr.y - br.y;
  const dy2 = bl.y - br.y;
  const dy3 = tl.y - tr.y + br.y - bl.y;
  const den = dx1 * dy2 - dx2 * dy1;
  let g1 = 0;
  let g2 = 0;
  if (den !== 0 && (dx3 !== 0 || dy3 !== 0)) {
    g1 = (dx3 * dy2 - dx2 * dy3) / den;
    g2 = (dx1 * dy3 - dx3 * dy1) / den;
  }
  const a = tr.x - tl.x + g1 * tr.x;
  const b = bl.x - tl.x + g2 * bl.x;
  const c = tl.x;
  const d = tr.y - tl.y + g1 * tr.y;
  const e = bl.y - tl.y + g2 * bl.y;
  const f = tl.y;

  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let v = 0; v < outH; v++) {
    const vv = (v + 0.5) / outH;
    for (let u = 0; u < outW; u++) {
      const uu = (u + 0.5) / outW;
      const den2 = g1 * uu + g2 * vv + 1;
      const x = (a * uu + b * vv + c) / den2;
      const y = (d * uu + e * vv + f) / den2;
      const o = (v * outW + u) * 4;
      // Half a pixel of slack: the last pixel centre of a full-frame quad sits at
      // sw − 0.5, and a card that fills the frame must not gain a white seam.
      if (x < 0 || y < 0 || x > sw - 0.5 || y > sh - 0.5) {
        out[o] = 255; out[o + 1] = 255; out[o + 2] = 255; out[o + 3] = 255;
        continue;
      }
      // The last source row/column has no neighbour to interpolate towards — clamp
      // instead, so a card that fills the frame keeps its border instead of a white seam.
      const x0 = Math.min(x | 0, sw - 2);
      const y0 = Math.min(y | 0, sh - 2);
      const fx = x - x0;
      const fy = y - y0;
      const i0 = (y0 * sw + x0) * 4;
      const i1 = i0 + 4;
      const i2 = i0 + sw * 4;
      const i3 = i2 + 4;
      for (let k = 0; k < 3; k++) {
        const top = src[i0 + k]! + (src[i1 + k]! - src[i0 + k]!) * fx;
        const bot = src[i2 + k]! + (src[i3 + k]! - src[i2 + k]!) * fx;
        out[o + k] = top + (bot - top) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

// ------------------------------------------------------------ detection + warp

/**
 * Finds the card in a full-resolution frame. Returns corners in full-resolution
 * pixels, or null when nothing card-shaped is there. Never throws for "no card".
 */
export async function detectCard(src: CanvasImageSource, sw: number, sh: number): Promise<Quad | null> {
  const k = Math.min(1, DETECT_W / Math.max(sw, sh));
  const tw = Math.max(2, Math.round(sw * k));
  const th = Math.max(2, Math.round(sh * k));
  const thumb = document.createElement('canvas');
  thumb.width = tw;
  thumb.height = th;
  thumb.getContext('2d')!.drawImage(src, 0, 0, tw, th);

  const found = await inferCorners(thumb);
  if (!found) return null;
  let quad = scaleQuad(found, sw / tw, sh / th);
  // Channels already come out tl/tr/br/bl, but a squashed card can order itself
  // into a bow-tie — reordering costs nothing and the warp would be garbage.
  if (!quadIsSane(quad, sw, sh)) quad = orderQuadPoints([quad.tl, quad.tr, quad.br, quad.bl]);
  if (!quadIsSane(quad, sw, sh)) return null;
  // Cards, receipts and A4 — not a door frame that happens to be 3:1.
  const aspect = quadAspect(quad);
  return aspect >= 1.1 && aspect <= 2.7 ? quad : null;
}

/**
 * Warps the quad flat (perspective correction). Falls back to the caller's corners
 * when detection is off, and returns null when nothing usable is there.
 */
export async function extractCard(
  src: CanvasImageSource, sw: number, sh: number, corners?: Quad | null,
): Promise<{ canvas: HTMLCanvasElement; quad: Quad } | null> {
  const quad = corners ?? (await detectCard(src, sw, sh));
  if (!quad || !quadIsSane(quad, sw, sh)) return null;
  const { w, h } = outputSizeFor(quad);

  const frame = document.createElement('canvas');
  frame.width = sw;
  frame.height = sh;
  const fctx = frame.getContext('2d', { willReadFrequently: true })!;
  fctx.drawImage(src, 0, 0, sw, sh);
  const pixels = fctx.getImageData(0, 0, sw, sh).data;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.putImageData(new ImageData(warpPixels(pixels, sw, sh, quad, w, h), w, h), 0, 0);
  return { canvas, quad };
}
