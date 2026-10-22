/** Clean-scan pipeline (SCAN-02): auto colour clean-up, all on-device.
 *
 * Capture/upload goes straight to the fill-in form: the photo is flattened (shadows and
 * yellow indoor light go white again) and levelled so print reads dark on white.
 * No crop step, no filter picker — one "Enhance card" toggle on the Scan screen.
 * No package — plain canvas, so the 2 MB install budget is untouched.
 */
import { compressCard } from './image';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** "Enhance card" toggle on the Scan screen — on unless the person switched it off. */
const ENHANCE_KEY = 'wetasnap-enhance';
export const isEnhanceEnabled = () => {
  try {
    return localStorage.getItem(ENHANCE_KEY) !== 'off';
  } catch {
    return true;
  }
};
export const setEnhanceEnabled = (on: boolean) => {
  try {
    localStorage.setItem(ENHANCE_KEY, on ? 'on' : 'off');
  } catch {
    /* private mode */
  }
};

/** How much of the background correction a pixel gets: anything clearly darker than its
 * neighbourhood (real print, including faint grey small print) gets none — only paper and
 * light shadows are lifted. Smoothstep on the pixel-to-background ratio. Pure. */
export function flattenWeight(pixLum: number, bgLum: number): number {
  const t = clamp((pixLum / Math.max(1, bgLum) - 0.75) / 0.2, 0, 1);
  return t * t * (3 - 2 * t);
}

/** Axis-aligned card bounds in mask pixels (half-open {x, y, w, h}). Pure: unit-tested.
 * Majority vote per row/column (fill >= 0.3) so specks can't move an edge, then a 3%
 * safety pad so print near the card edge is never clipped. Returns null when there is
 * nothing worth cutting: empty, full-bleed, tiny (<15%) or the whole frame. */
export interface CardRect { x: number; y: number; w: number; h: number }
export function boundsOfMask(fg: Uint8Array, w: number, h: number): CardRect | null {
  const FILL = 0.3;
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = 0; x < w; x++) n += fg[y * w + x]!;
    if (n / w >= FILL) { if (top < 0) top = y; bottom = y; }
  }
  let left = -1;
  let right = -1;
  for (let x = 0; x < w; x++) {
    let n = 0;
    for (let y = 0; y < h; y++) n += fg[y * w + x]!;
    if (n / h >= FILL) { if (left < 0) left = x; right = x; }
  }
  if (top < 0 || left < 0) return null;
  const area = ((right - left + 1) * (bottom - top + 1)) / (w * h);
  if (area < 0.15 || area > 0.995) return null;
  if (top <= 1 && left <= 1 && bottom >= h - 2 && right >= w - 2) return null;
  const padX = Math.ceil(w * 0.03);
  const padY = Math.ceil(h * 0.03);
  const x0 = Math.max(0, left - padX);
  const y0 = Math.max(0, top - padY);
  const x1 = Math.min(w, right + 1 + padX);
  const y1 = Math.min(h, bottom + 1 + padY);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Background = whatever touches the photo border (flood fill on a thumbnail, so a
 * multi-colour table still counts: each border colour seeds its own region). Anything the
 * fill can't reach is the card. Stops at the card edge where neighbour colours jump. */
function cardMask(data: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const bg = new Uint8Array(w * h);
  const q = new Int32Array(w * h);
  let qh = 0;
  let qt = 0;
  const seed = (x: number, y: number) => {
    const i = y * w + x;
    if (!bg[i]) { bg[i] = 1; q[qt++] = i; }
  };
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }
  const T2 = 45 * 45;
  while (qh < qt) {
    const i = q[qh++]!;
    const ix = i % w;
    const iy = (i / w) | 0;
    const r = data[i * 4]!;
    const g = data[i * 4 + 1]!;
    const b = data[i * 4 + 2]!;
    const visit = (j: number) => {
      if (bg[j]) return;
      const dr = data[j * 4]! - r;
      const dg = data[j * 4 + 1]! - g;
      const db = data[j * 4 + 2]! - b;
      if (dr * dr + dg * dg + db * db < T2) { bg[j] = 1; q[qt++] = j; }
    };
    if (ix > 0) visit(i - 1);
    if (ix < w - 1) visit(i + 1);
    if (iy > 0) visit(i - w);
    if (iy < h - 1) visit(i + w);
  }
  const fg = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) fg[i] = bg[i] ? 0 : 1;
  return fg;
}

/** Card rectangle in full-resolution pixels, or null when no safe cut exists (card already
 * fills the frame, or the background is indistinguishable — then the whole photo is kept
 * rather than risking a side). */
function detectCardRect(src: HTMLCanvasElement): CardRect | null {
  const sw = src.width;
  const sh = src.height;
  if (sw < 40 || sh < 40) return null;
  const W = 160;
  const H = clamp(Math.round((160 * sh) / sw), 60, 160);
  const t = document.createElement('canvas');
  t.width = W;
  t.height = H;
  t.getContext('2d')!.drawImage(src, 0, 0, W, H);
  const data = t.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, W, H).data;
  const found = boundsOfMask(cardMask(data, W, H), W, H);
  if (!found) return null;
  // Thumb pad (3%) plus one more percent at full resolution: detection error must eat
  // margin, never card edge.
  const padX = Math.round(sw * 0.01);
  const padY = Math.round(sh * 0.01);
  const x0 = Math.max(0, Math.round((found.x / W) * sw) - padX);
  const y0 = Math.max(0, Math.round((found.y / H) * sh) - padY);
  const x1 = Math.min(sw, Math.round(((found.x + found.w) / W) * sw) + padX);
  const y1 = Math.min(sh, Math.round(((found.y / H) * sh + found.h / H) * sh) + padY);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  if ((w * h) / (sw * sh) > 0.98) return null; // trivial shave — keep the original pixels
  if ((w * h) / (sw * sh) < 0.12) return null; // implausibly small — a false positive
  return { x: x0, y: y0, w, h };
}

function cropCanvas(src: HTMLCanvasElement, r: CardRect): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = Math.max(2, r.w);
  out.height = Math.max(2, r.h);
  out.getContext('2d')!.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, out.width, out.height);
  return out;
}

/** Cap the long side. */
function fitCanvas(src: HTMLCanvasElement, maxSide: number): HTMLCanvasElement {
  const k = Math.min(1, maxSide / Math.max(1, Math.max(src.width, src.height)));
  if (k >= 1) return src;
  const out = document.createElement('canvas');
  out.width = Math.max(2, Math.round(src.width * k));
  out.height = Math.max(2, Math.round(src.height * k));
  out.getContext('2d')!.drawImage(src, 0, 0, out.width, out.height);
  return out;
}

/** Flatten uneven light with ONE luminance gain per pixel (same factor on R, G and B), so a
 * shadowed corner lands on white again without shifting any hue. */
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
  const atLum = (fx: number, fy: number) =>
    0.299 * at(fx, fy, 0) + 0.587 * at(fx, fy, 1) + 0.114 * at(fx, fy, 2);
  // Global paper-neutral white balance from the thumbnail's bright pixels (lamp tint only).
  // Mild by design: ±8% max, so coloured print never shifts.
  const pr: number[] = [];
  const pg: number[] = [];
  const pb: number[] = [];
  for (let i = 0; i < tw * th; i++) {
    const lum = 0.299 * bg[i * 4]! + 0.587 * bg[i * 4 + 1]! + 0.114 * bg[i * 4 + 2]!;
    if (lum >= 150) { pr.push(bg[i * 4]!); pg.push(bg[i * 4 + 1]!); pb.push(bg[i * 4 + 2]!); }
  }
  const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]! : 0);
  const mr = med(pr);
  const mg = med(pg);
  const mb = med(pb);
  const paperLum = 0.299 * mr + 0.587 * mg + 0.114 * mb;
  // Very gentle: ±4% max — just takes the lamp tint off, never repaints the card.
  const bal = [mr, mg, mb].map((ch) => (ch > 0 && paperLum > 0 ? clamp(paperLum / ch, 0.96, 1.04) : 1));
  for (let y = 0; y < h; y++) {
    const fy = ((y + 0.5) / h) * th - 0.5;
    for (let x = 0; x < w; x++) {
      const fx = ((x + 0.5) / w) * tw - 0.5;
      const i = (y * w + x) * 4;
      d[i] = Math.min(255, d[i]! * bal[0]!);
      d[i + 1] = Math.min(255, d[i + 1]! * bal[1]!);
      d[i + 2] = Math.min(255, d[i + 2]! * bal[2]!);
      const lum = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
      const bgLum = atLum(fx, fy);
      const wgt = flattenWeight(lum, bgLum); // 0 on print → untouched
      if (wgt <= 0) continue;
      // Gentle: paper lifts at most 12% — shadows soften, print never moves.
      const gain = 1 + (Math.min(1.12, 255 / Math.max(1, bgLum)) - 1) * wgt;
      d[i] = Math.min(255, d[i]! * gain);
      d[i + 1] = Math.min(255, d[i + 1]! * gain);
      d[i + 2] = Math.min(255, d[i + 2]! * gain);
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Black point: near the darkest real ink (0.5th percentile). Pure. */
export function inkBlack(samples: number[]): number {
  if (!samples.length) return 25;
  const s = [...samples].sort((a, b) => a - b);
  return clamp(s[Math.floor(s.length * 0.005)] ?? 25, 0, 60);
}

/** White point: 90th percentile of all samples — paper covers most of a card. Pure. */
export function paperWhite(samples: number[]): number {
  if (!samples.length) return 235;
  const s = [...samples].sort((a, b) => a - b);
  return clamp(s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] ?? 235, 170, 255);
}

/** 1st/99th percentile of samples — the white margin and the black print, ignoring specks. */
export function autoLevels(samples: number[]): [number, number] {
  if (!samples.length) return [0, 255];
  const s = [...samples].sort((a, b) => a - b);
  const lo = s[Math.floor(s.length * 0.01)] ?? 0;
  const hi = s[Math.ceil(s.length * 0.99) - 1] ?? 255;
  return hi - lo < 12 ? [Math.max(0, lo - 6), Math.min(255, hi + 6)] : [lo, hi];
}

/** Near-identity tonal touch: paper snaps white, crushed blacks open a whisper, every
 * other pixel passes through byte-identical. Max shift 6 — the curve cannot ruin anything.
 * All real work (shadow lift, lamp tint) already happened in flatten. Pure. */
export function enhanceCurve(v: number, black: number, white: number): number {
  if (v >= white - 2) return 255;
  if (v <= black) return Math.min(255, black + 6);
  return clamp(v, 0, 255);
}

function stretch(c: HTMLCanvasElement) {
  const w = c.width;
  const h = c.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const step = Math.max(1, Math.floor((w * h) / 20000));
  const lum: number[] = [];
  for (let i = 0; i < w * h; i += step) lum.push(0.299 * d[i * 4]! + 0.587 * d[i * 4 + 1]! + 0.114 * d[i * 4 + 2]!);
  const white = paperWhite(lum);
  const black = inkBlack(lum);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    // Luminance-driven curve, applied as ONE ratio per pixel: hue is preserved exactly.
    const v = 0.299 * d[o]! + 0.587 * d[o + 1]! + 0.114 * d[o + 2]!;
    const target = enhanceCurve(v, black, white);
    const ratio = v > 1 ? target / v : 1;
    for (let ch = 0; ch < 3; ch++) d[o + ch] = clamp(d[o + ch]! * ratio, 0, 255);
  }
  ctx.putImageData(img, 0, 0);
}

/** Sauvola binarisation on a grey array — kept for the OCR pre-pass. Pure: unit-tested. */
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

function saturate(c: HTMLCanvasElement, amount: number) {
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const avg = (d[i]! + d[i + 1]! + d[i + 2]!) / 3;
    d[i] = clamp(avg + (d[i]! - avg) * amount, 0, 255);
    d[i + 1] = clamp(avg + (d[i + 1]! - avg) * amount, 0, 255);
    d[i + 2] = clamp(avg + (d[i + 2]! - avg) * amount, 0, 255);
  }
  ctx.putImageData(img, 0, 0);
}

/** Mild 3×3 sharpen — thin print crisps up without haloing at this amount. */
function sharpen(c: HTMLCanvasElement, a = 0.12) {
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
      for (let ch = 0; ch < 3; ch++) {
        const nb = s[(yu * w + x) * 4 + ch]! + s[(yd * w + x) * 4 + ch]! + s[(y * w + xl) * 4 + ch]! + s[(y * w + xr) * 4 + ch]!;
        o[i + ch] = clamp(s[i + ch]! * (1 + 4 * a) - nb * a, 0, 255);
      }
      o[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
}

// ---------------------------------------------------------------- public pipeline

/** Auto colour clean-up: detect the card (tables/desks cut away, padded so no side is
 * lost) → flatten → barely-there level → whisper of punch. A missed detection keeps the
 * whole photo — never a wrong cut. */
function develop(src: HTMLCanvasElement, maxSide: number): HTMLCanvasElement {
  const found = detectCardRect(src);
  const c = fitCanvas(found ? cropCanvas(src, found) : src, maxSide);
  flatten(c);
  stretch(c);
  saturate(c, 1.03);
  sharpen(c, 0.08);
  return c;
}

async function bitmapOf(photo: Blob | HTMLCanvasElement): Promise<HTMLCanvasElement> {
  if (!(photo instanceof Blob)) return photo; // already the capture canvas: no decode, no encode
  const bmp = await createImageBitmap(photo);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}

/** Full-frame clean scan in the colour look, compressed ≤ 420 KB. Takes the capture canvas as
 *  well as a blob, so a live capture is encoded once instead of twice (SCAN-06). */
export async function autoEnhance(src: Blob | HTMLCanvasElement): Promise<Blob> {
  return compressCard(develop(await bitmapOf(src), 2000));
}
