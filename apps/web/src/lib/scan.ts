/** Clean-scan pipeline (SCAN-02): CamScanner-style straightening + cleanup, all on-device.
 *
 * The photo becomes a flat, straight, evenly-lit scan: an optional perspective warp pulls the
 * card's own corners into a rectangle, then the background is flattened (shadows and yellow
 * indoor light go white again) and the levels are stretched so print reads black on white.
 * No package — plain canvas, so the 2 MB install budget is untouched.
 */
import { compressCard } from './image';

export type ScanFilter = 'enhance' | 'color' | 'gray' | 'bw';
export interface Pt { x: number; y: number }
export interface Quad { tl: Pt; tr: Pt; br: Pt; bl: Pt }

export const rectToQuad = (w: number, h: number, inset = 0): Quad => ({
  tl: { x: inset, y: inset },
  tr: { x: w - inset, y: inset },
  br: { x: w - inset, y: h - inset },
  bl: { x: inset, y: h - inset },
});

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Map an image point through a 0/90/180/270° clockwise turn (canvas semantics). */
export function rotFwd(p: Pt, w: number, h: number, r: number): Pt {
  const d = ((r % 360) + 360) % 360;
  if (d === 90) return { x: h - p.y, y: p.x };
  if (d === 180) return { x: w - p.x, y: h - p.y };
  if (d === 270) return { x: p.y, y: w - p.x };
  return { ...p };
}

/** Inverse of rotFwd: a point in the turned image (w × h) back to the original photo. */
export function rotInv(p: Pt, w: number, h: number, r: number): Pt {
  const d = ((r % 360) + 360) % 360;
  if (d === 90) return { x: p.y, y: w - p.x };
  if (d === 180) return { x: w - p.x, y: h - p.y };
  if (d === 270) return { x: h - p.y, y: p.x };
  return { ...p };
}

/** Move a delta through the inverse rotation (translation only — deltas ignore offsets). */
export function rotInvDelta(d: Pt, r: number): Pt {
  const a = ((r % 360) + 360) % 360;
  if (a === 90) return { x: d.y, y: -d.x };
  if (a === 180) return { x: -d.x, y: -d.y };
  if (a === 270) return { x: -d.y, y: d.x };
  return { ...d };
}

// ---------------------------------------------------------------- homography (pure, tested)

type H = [number, number, number, number, number, number, number, number, number];

/** 3×3 homography mapping `dst` corners onto `src` corners (direct linear transform). */
export function solveH(dst: Pt[], src: Pt[]): H {
  const a: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const xd = dst[i]!.x;
    const yd = dst[i]!.y;
    const xs = src[i]!.x;
    const ys = src[i]!.y;
    a.push([xd, yd, 1, 0, 0, 0, -xs * xd, -xs * yd, xs]);
    a.push([0, 0, 0, xd, yd, 1, -ys * xd, -ys * yd, ys]);
  }
  // Gaussian elimination with partial pivoting, h[8] = 1.
  for (let col = 0; col < 8; col++) {
    let piv = col;
    for (let row = col + 1; row < 8; row++) {
      if (Math.abs(a[row]![col]!) > Math.abs(a[piv]![col]!)) piv = row;
    }
    const tmp = a[col]!;
    a[col] = a[piv]!;
    a[piv] = tmp;
    const crow = a[col]!;
    const div = crow[col]!;
    for (let k = col; k < 9; k++) crow[k] = crow[k]! / div;
    for (let row = 0; row < 8; row++) {
      if (row === col) continue;
      const rrow = a[row]!;
      const f = rrow[col]!;
      if (f !== 0) for (let k = col; k < 9; k++) rrow[k] = rrow[k]! - f * crow[k]!;
    }
  }
  return [a[0]![8]!, a[1]![8]!, a[2]![8]!, a[3]![8]!, a[4]![8]!, a[5]![8]!, a[6]![8]!, a[7]![8]!, 1];
}

export function applyH(h: H, x: number, y: number): Pt {
  const w = h[6]! * x + h[7]! * y + h[8]!;
  return { x: (h[0]! * x + h[1]! * y + h[2]!) / w, y: (h[3]! * x + h[4]! * y + h[5]!) / w };
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Rough quad area vs the photo — a collapsed quad falls back to the full frame. */
function quadArea(q: Quad, w: number, h: number) {
  const pts = [q.tl, q.tr, q.br, q.bl];
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % 4]!;
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2 / Math.max(1, w * h);
}

// ---------------------------------------------------------------- per-pixel stages (canvas)

function warpCanvas(src: HTMLCanvasElement, quad: Quad | null, maxSide: number): HTMLCanvasElement {
  const sw = src.width;
  const sh = src.height;
  const q = quad && quadArea(quad, sw, sh) > 0.03 ? quad : rectToQuad(sw, sh);
  const top = dist(q.tl, q.tr);
  const bot = dist(q.bl, q.br);
  const left = dist(q.tl, q.bl);
  const right = dist(q.tr, q.br);
  let ow = Math.max(2, Math.round(Math.max(top, bot)));
  let oh = Math.max(2, Math.round(Math.max(left, right)));
  const k = Math.min(1, maxSide / Math.max(ow, oh));
  ow = Math.max(2, Math.round(ow * k));
  oh = Math.max(2, Math.round(oh * k));

  const sctx = src.getContext('2d', { willReadFrequently: true })!;
  const s = sctx.getImageData(0, 0, sw, sh);
  const out = document.createElement('canvas');
  out.width = ow;
  out.height = oh;
  const octx = out.getContext('2d')!;
  const o = octx.createImageData(ow, oh);
  const h = solveH([{ x: 0, y: 0 }, { x: ow, y: 0 }, { x: ow, y: oh }, { x: 0, y: oh }], [q.tl, q.tr, q.br, q.bl]);
  const sd = s.data;
  const od = o.data;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const p = applyH(h, x + 0.5, y + 0.5);
      const x0 = clamp(Math.floor(p.x - 0.5), 0, sw - 1);
      const y0 = clamp(Math.floor(p.y - 0.5), 0, sh - 1);
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const fx = clamp(p.x - 0.5 - x0, 0, 1);
      const fy = clamp(p.y - 0.5 - y0, 0, 1);
      const oi = (y * ow + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v00 = sd[(y0 * sw + x0) * 4 + c]!;
        const v10 = sd[(y0 * sw + x1) * 4 + c]!;
        const v01 = sd[(y1 * sw + x0) * 4 + c]!;
        const v11 = sd[(y1 * sw + x1) * 4 + c]!;
        od[oi + c] = v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
      }
      od[oi + 3] = 255;
    }
  }
  octx.putImageData(o, 0, 0);
  return out;
}

/** Flatten uneven light: each pixel is divided by its blurred neighbourhood, so a shadowed
 * corner and a yellow lamp both land on white again. The thumbnail *is* the blur. */
function flatten(c: HTMLCanvasElement) {
  const w = c.width;
  const h = c.height;
  const tw = 48;
  const th = Math.max(1, Math.round((48 * h) / w));
  const t = document.createElement('canvas');
  t.width = tw;
  t.height = th;
  const tctx = t.getContext('2d', { willReadFrequently: true })!;
  tctx.drawImage(c, 0, 0, tw, th); // downscaling averages — a strong blur for free
  const bg = tctx.getImageData(0, 0, tw, th).data;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const at = (fx: number, fy: number, ch: number) => {
    const x0 = clamp(Math.floor(fx), 0, tw - 1);
    const y0 = clamp(Math.floor(fy), 0, th - 1);
    const x1 = Math.min(tw - 1, x0 + 1);
    const y1 = Math.min(th - 1, y0 + 1);
    const ax = fx - x0;
    const ay = fy - y0;
    const i00 = (y0 * tw + x0) * 4 + ch;
    const i10 = (y0 * tw + x1) * 4 + ch;
    const i01 = (y1 * tw + x0) * 4 + ch;
    const i11 = (y1 * tw + x1) * 4 + ch;
    return bg[i00]! * (1 - ax) * (1 - ay) + bg[i10]! * ax * (1 - ay) + bg[i01]! * (1 - ax) * ay + bg[i11]! * ax * ay;
  };
  for (let y = 0; y < h; y++) {
    const fy = ((y + 0.5) / h) * th - 0.5;
    for (let x = 0; x < w; x++) {
      const fx = ((x + 0.5) / w) * tw - 0.5;
      const i = (y * w + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const b = Math.max(1, at(fx, fy, ch));
        const gain = Math.min(1.9, 255 / b); // capped: never amplify sensor noise into speckles
        d[i + ch] = Math.min(255, d[i + ch]! * gain);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** 1st/99th percentile of samples — the white margin and the black print, ignoring specks. */
export function autoLevels(samples: number[]): [number, number] {
  if (!samples.length) return [0, 255];
  const s = [...samples].sort((a, b) => a - b);
  const lo = s[Math.floor(s.length * 0.01)] ?? 0;
  const hi = s[Math.ceil(s.length * 0.99) - 1] ?? 255;
  return hi - lo < 12 ? [Math.max(0, lo - 6), Math.min(255, hi + 6)] : [lo, hi];
}

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)))] ?? 0;

/** Paper white vs ink black from luminance samples — bright/dark percentiles, ignoring specks.
 * On a light card `paper` is the card stock; on a dark card it is the light print. Either way
 * the curve below does the right thing: near-white goes pure white, dark stays dark. */
export function estimatePaperInk(samples: number[]): { paper: number; ink: number } {
  if (!samples.length) return { paper: 255, ink: 0 };
  const s = [...samples].sort((a, b) => a - b);
  let ink = quantile(s, 0.06);
  let paper = quantile(s, 0.92);
  if (paper - ink < 25) {
    ink = Math.max(0, ink - 12);
    paper = Math.min(255, paper + 12);
  }
  return { paper, ink };
}

/** Target luminance for one pixel: ink → black, paper → white, mid-tones bowed slightly dark
 * so print reads bold, with a smooth knee that melts paper grain into pure white. Pure. */
export function targetLum(l: number, paper: number, ink: number, whiten = true): number {
  const span = Math.max(1, paper - ink);
  const norm = clamp((l - ink) / span, 0, 1);
  if (whiten) {
    if (norm >= 0.93) return 255;
    if (norm > 0.78) {
      const t = (norm - 0.78) / 0.15;
      const e = t * t * (3 - 2 * t);
      const base = Math.pow(norm, 1.12) * 255;
      return base + (255 - base) * e;
    }
  }
  return Math.pow(norm, whiten ? 1.12 : 1.0) * 255;
}

/** One-pass levels that preserve hue: every channel rides the luminance curve, so the paper
 * goes white without shifting the logo colours, and print goes bold without clipping. */
function cleanPage(c: HTMLCanvasElement, whiten: boolean) {
  const w = c.width;
  const h = c.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const step = Math.max(1, Math.floor((w * h) / 20000));
  const lum: number[] = [];
  for (let i = 0; i < w * h; i += step) lum.push(0.299 * d[i * 4]! + 0.587 * d[i * 4 + 1]! + 0.114 * d[i * 4 + 2]!);
  const { paper, ink } = estimatePaperInk(lum);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const l = 0.299 * d[o]! + 0.587 * d[o + 1]! + 0.114 * d[o + 2]!;
    const t = targetLum(l, paper, ink, whiten);
    const ratio = t / Math.max(1, l);
    d[o] = clamp(d[o]! * ratio, 0, 255);
    d[o + 1] = clamp(d[o + 1]! * ratio, 0, 255);
    d[o + 2] = clamp(d[o + 2]! * ratio, 0, 255);
  }
  ctx.putImageData(img, 0, 0);
}

function stretch(c: HTMLCanvasElement, gray: boolean) {
  const w = c.width;
  const h = c.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const step = Math.max(1, Math.floor((w * h) / 20000));
  const lum: number[] = [];
  for (let i = 0; i < w * h; i += step) lum.push(0.299 * d[i * 4]! + 0.587 * d[i * 4 + 1]! + 0.114 * d[i * 4 + 2]!);
  const [lo, hi] = autoLevels(lum);
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (gray) {
      const v = clamp(((0.299 * d[o]! + 0.587 * d[o + 1]! + 0.114 * d[o + 2]! - lo) / span) * 255, 0, 255);
      d[o] = d[o + 1] = d[o + 2] = v;
    } else {
      for (let ch = 0; ch < 3; ch++) d[o + ch] = clamp(((d[o + ch]! - lo) / span) * 255, 0, 255);
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Sauvola binarisation on a grey array — print stays solid under uneven light where one
 * global threshold would eat thin strokes or fill the page black. Pure: unit-tested. */
export function sauvolaBinarize(gray: Float32Array | number[], w: number, h: number, k = 0.2): Uint8ClampedArray {
  const r = clamp(Math.round(Math.min(w, h) / 60), 8, 40);
  const sat = new Float64Array((w + 1) * (h + 1));
  const sat2 = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    let row2 = 0;
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x]!;
      row += v;
      row2 += v * v;
      sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1]! + row;
      sat2[(y + 1) * (w + 1) + x + 1] = sat2[y * (w + 1) + x + 1]! + row2;
    }
  }
  const sum = (s: Float64Array, x0: number, y0: number, x1: number, y1: number) =>
    s[y1 * (w + 1) + x1]! - s[y0 * (w + 1) + x1]! - s[y1 * (w + 1) + x0]! + s[y0 * (w + 1) + x0]!;
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const n = (x1 - x0) * (y1 - y0);
      const m = sum(sat, x0, y0, x1, y1) / n;
      const v = sum(sat2, x0, y0, x1, y1) / n - m * m;
      const t = m * (1 + k * (Math.sqrt(Math.max(0, v)) / 128 - 1));
      out[y * w + x] = gray[y * w + x]! < t ? 0 : 255;
    }
  }
  return out;
}

function toMono(c: HTMLCanvasElement) {
  const w = c.width;
  const h = c.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, w, h);
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = 0.299 * img.data[i * 4]! + 0.587 * img.data[i * 4 + 1]! + 0.114 * img.data[i * 4 + 2]!;
  const bw = sauvolaBinarize(gray, w, h);
  for (let i = 0; i < w * h; i++) img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = bw[i]!;
  ctx.putImageData(img, 0, 0);
}

function saturate(c: HTMLCanvasElement, amount: number) {
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
    if (l > 225) continue; // near-white paper: keep it white, don't wake the grain
    const avg = (d[i]! + d[i + 1]! + d[i + 2]!) / 3;
    d[i] = clamp(avg + (d[i]! - avg) * amount, 0, 255);
    d[i + 1] = clamp(avg + (d[i + 1]! - avg) * amount, 0, 255);
    d[i + 2] = clamp(avg + (d[i + 2]! - avg) * amount, 0, 255);
  }
  ctx.putImageData(img, 0, 0);
}

/** 3×3 median on near-white pixels only: melts paper grain and JPEG speckle into pure
 * white while every dark pixel of print passes through untouched. Pure-adjacent, canvas I/O only. */
function despeckleWhite(c: HTMLCanvasElement) {
  const w = c.width;
  const h = c.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const src = ctx.getImageData(0, 0, w, h);
  const out = ctx.createImageData(w, h);
  const s = src.data;
  const o = out.data;
  const win = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      o[i + 3] = 255;
      const l = 0.299 * s[i]! + 0.587 * s[i + 1]! + 0.114 * s[i + 2]!;
      if (l < 208) {
        o[i] = s[i]!; o[i + 1] = s[i + 1]!; o[i + 2] = s[i + 2]!;
        continue;
      }
      for (let ch = 0; ch < 3; ch++) {
        for (let k = 0; k < 9; k++) {
          const nx = clamp(x + (k % 3) - 1, 0, w - 1);
          const ny = clamp(y + Math.floor(k / 3) - 1, 0, h - 1);
          win[k] = s[(ny * w + nx) * 4 + ch]!;
        }
        win.sort((a, b) => a - b);
        o[i + ch] = win[4]!;
      }
    }
  }
  ctx.putImageData(out, 0, 0);
}

/** Print-safe unsharp mask: crisps edges but skips near-white pixels, so paper grain is
 * never sharpened into speckle. Mild amount — no haloing at thin print sizes. */
function sharpen(c: HTMLCanvasElement, a = 0.22) {
  const w = c.width;
  const h = c.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const src = ctx.getImageData(0, 0, w, h);
  const out = ctx.createImageData(w, h);
  const s = src.data;
  const o = out.data;
  for (let y = 0; y < h; y++) {
    const yu = y > 0 ? y - 1 : y;
    const yd = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const xl = x > 0 ? x - 1 : x;
      const xr = x < w - 1 ? x + 1 : x;
      const i = (y * w + x) * 4;
      o[i + 3] = 255;
      const l = 0.299 * s[i]! + 0.587 * s[i + 1]! + 0.114 * s[i + 2]!;
      if (l > 225) {
        o[i] = s[i]!; o[i + 1] = s[i + 1]!; o[i + 2] = s[i + 2]!;
        continue;
      }
      for (let ch = 0; ch < 3; ch++) {
        const nb = s[(yu * w + x) * 4 + ch]! + s[(yd * w + x) * 4 + ch]! + s[(y * w + xl) * 4 + ch]! + s[(y * w + xr) * 4 + ch]!;
        o[i + ch] = clamp(s[i + ch]! * (1 + 4 * a) - nb * a, 0, 255);
      }
    }
  }
  ctx.putImageData(out, 0, 0);
}

function rotate(c: HTMLCanvasElement, r: number): HTMLCanvasElement {
  const d = ((r % 360) + 360) % 360;
  if (!d) return c;
  const turned = d % 180 !== 0;
  const out = document.createElement('canvas');
  out.width = turned ? c.height : c.width;
  out.height = turned ? c.width : c.height;
  const ctx = out.getContext('2d')!;
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((d * Math.PI) / 180);
  ctx.drawImage(c, -c.width / 2, -c.height / 2);
  return out;
}

// ---------------------------------------------------------------- public pipeline

function develop(src: HTMLCanvasElement, quad: Quad | null, filter: ScanFilter, maxSide: number): HTMLCanvasElement {
  const c = warpCanvas(src, quad, maxSide);
  if (filter === 'color') {
    stretch(c, false); // straightened, lightly levelled — colours as printed
    return c;
  }
  flatten(c);
  if (filter === 'bw') {
    toMono(c);
    return c;
  }
  if (filter === 'gray') {
    despeckleWhite(c);
    cleanPage(c, false); // even levels, no whitening knee — grey stays photographic
    return c;
  }
  // enhance: the CamScanner look — flat white page, bold print, quiet grain.
  despeckleWhite(c);
  cleanPage(c, true); // hue-preserving paper→white curve (ageas red stays red)
  saturate(c, 1.12);
  sharpen(c);
  return c;
}

async function bitmapOf(photo: Blob): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(photo);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}

function toBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((res, rej) =>
    c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/jpeg', 0.92),
  );
}

/** The full clean scan: straighten to the quad, enhance, turn upright, compress ≤ 300 KB. */
export async function scanBlob(photo: Blob, quad: Quad | null, rotation: number, filter: ScanFilter): Promise<Blob> {
  const c = rotate(develop(await bitmapOf(photo), quad, filter, 1600), rotation);
  return compressCard(c);
}

/** Batch uploads skip the corner editor — full-frame clean scan with the default look. */
export async function autoEnhance(photo: Blob, filter: ScanFilter = 'enhance'): Promise<Blob> {
  return scanBlob(photo, null, 0, filter);
}

/** Small true preview for the corner editor (same pipeline, capped at 640 px). */
export async function scanPreview(photo: Blob, quad: Quad | null, rotation: number, filter: ScanFilter): Promise<Blob> {
  const c = rotate(develop(await bitmapOf(photo), quad, filter, 640), rotation);
  return toBlob(c);
}
