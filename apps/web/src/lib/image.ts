/** Card photo processing in the browser — no extra package (URS §10.1).
 *  Crop to the card frame, resize to ~1600 px, compress to ≤ 300 KB (SCAN-06). */

export const MAX_BYTES = 300 * 1024;
const TARGET_W = 1600;

export async function compressCard(src: Blob | HTMLVideoElement | HTMLCanvasElement, crop?: { x: number; y: number; w: number; h: number }): Promise<Blob> {
  const bmp = src instanceof Blob ? await createImageBitmap(src) : src;
  const sw = 'videoWidth' in bmp ? bmp.videoWidth : bmp.width;
  const sh = 'videoHeight' in bmp ? bmp.videoHeight : bmp.height;
  const c = crop ?? { x: 0, y: 0, w: sw, h: sh };
  const scale = Math.min(1, TARGET_W / c.w);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(c.w * scale);
  canvas.height = Math.round(c.h * scale);
  canvas.getContext('2d')!.drawImage(bmp as CanvasImageSource, c.x, c.y, c.w, c.h, 0, 0, canvas.width, canvas.height);
  if ('close' in bmp) (bmp as ImageBitmap).close();

  const webp = await supportsWebp();
  for (let q = 0.85; q >= 0.4; q -= 0.1) {
    const blob = await toBlob(canvas, webp ? 'image/webp' : 'image/jpeg', q);
    if (blob.size <= MAX_BYTES) return blob;
  }
  // Last resort: shrink dimensions.
  const small = document.createElement('canvas');
  small.width = Math.round(canvas.width * 0.7);
  small.height = Math.round(canvas.height * 0.7);
  small.getContext('2d')!.drawImage(canvas, 0, 0, small.width, small.height);
  return toBlob(small, webp ? 'image/webp' : 'image/jpeg', 0.6);
}

function toBlob(c: HTMLCanvasElement, type: string, q: number) {
  return new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), type, q));
}

let webpOk: boolean | undefined;
async function supportsWebp() {
  if (webpOk === undefined) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    webpOk = c.toDataURL('image/webp').startsWith('data:image/webp');
  }
  return webpOk;
}

/** The card-shaped frame (ISO/IEC 7810 ID-1 ratio 85.6 × 54) centred in the video, 82% of width. */
export function frameRect(w: number, h: number) {
  const ratio = 85.6 / 54;
  let fw = w * 0.82;
  let fh = fw / ratio;
  if (fh > h * 0.82) { fh = h * 0.82; fw = fh * ratio; }
  return { x: (w - fw) / 2, y: (h - fh) / 2, w: fw, h: fh };
}

/** Sharpness = variance of a Laplacian on a small grey sample. Used for auto-capture and the blur warning. */
export function sharpness(data: Uint8ClampedArray, w: number, h: number) {
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * data[i * 4]! + 0.587 * data[i * 4 + 1]! + 0.114 * data[i * 4 + 2]!;
  let sum = 0, sq = 0, n = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * g[i]! - g[i - 1]! - g[i + 1]! - g[i - w]! - g[i + w]!;
      sum += lap; sq += lap * lap; n++;
    }
  const mean = sum / n;
  return sq / n - mean * mean;
}

/** Mean absolute difference between two grey samples — low means the card is steady. */
export function motion(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  let d = 0;
  for (let i = 0; i < a.length; i += 16) d += Math.abs(a[i]! - b[i]!);
  return d / (a.length / 16);
}

// ---------------------------------------------------------------- is a card actually in the frame?

/** What one sample of the guide area looks like. All ratios are 0–1. */
export interface FrameCheck {
  /** How much of the frame is one flat, card-coloured surface. */
  flat: number;
  /** How flat the middle of the frame is, judged on its own — a card held too far away still counts. */
  centre: number;
  /** How much of the frame is either the card colour or the print colour: a QR code is all of it. */
  twoTone: number;
  /** Light↔dark changes along each row, per pixel: print and QR blocks are full of them, a card lying on a desk is not. */
  transitions: number;
  /** How much of that surface is print (text, logo, QR blocks), whether dark on light or light on dark. */
  ink: number;
  /** How much of the border ring is still that same surface — 1 means the card fills the guide. */
  ring: number;
  /** Strong gradients everywhere: a busy scene rather than a printed card. */
  edges: number;
}

/** Where a card is, as far as the camera can tell. */
export type Placement = 'none' | 'blank' | 'far' | 'ok';

const GREY = (data: Uint8ClampedArray, w: number, h: number) => {
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * data[i * 4]! + 0.587 * data[i * 4 + 1]! + 0.114 * data[i * 4 + 2]!;
  return g;
};

/**
 * A business card, a badge or a QR code is a flat surface with print on it, filling the guide.
 * A desk, a hand or a wall is either not flat, or flat with nothing printed on it — which is how
 * auto-capture tells them apart (SCAN-01).
 */
export function analyseFrame(data: Uint8ClampedArray, w: number, h: number): FrameCheck {
  const g = GREY(data, w, h);
  const n = w * h;

  // The card body is the commonest brightness. Take the 70th percentile as its level: cards are
  // mostly background, whether white, cream or dark.
  const sorted = Float32Array.from(g).sort();
  const body = sorted[Math.floor(n * 0.7)]!;
  const band = 26;

  // The print level: the other end of the histogram from the card body.
  const dark = sorted[Math.floor(n * 0.12)]!;

  let flat = 0;
  let ink = 0;
  let twoTone = 0;
  for (let i = 0; i < n; i++) {
    const d = g[i]! - body;
    if (Math.abs(d) <= band) { flat++; twoTone++; continue; }
    if (Math.abs(d) > 40) ink++; // print: dark on a light card, or light on a dark one
    if (Math.abs(g[i]! - dark) <= band) twoTone++;
  }


  // The middle of the guide, judged against its own colour: a card held too far away is still a
  // flat thing in the middle, even when the desk around it dominates the frame.
  const cx0 = Math.round(w * 0.2);
  const cx1 = Math.round(w * 0.8);
  const cy0 = Math.round(h * 0.2);
  const cy1 = Math.round(h * 0.8);
  const mid: number[] = [];
  for (let y = cy0; y < cy1; y++) for (let x = cx0; x < cx1; x++) mid.push(g[y * w + x]!);
  mid.sort((a, b) => a - b);
  const midBody = mid[Math.floor(mid.length * 0.7)] ?? body;
  let centreFlat = 0;
  for (const v of mid) if (Math.abs(v - midBody) <= band) centreFlat++;

  // The border ring of the guide, compared with whatever is in the middle: if the card fills the
  // frame the ring is the same colour, and if it is lying on a desk it is not.
  const m = Math.max(2, Math.round(Math.min(w, h) * 0.08));
  let ringPx = 0;
  let ringFlat = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= m && x < w - m && y >= m && y < h - m) continue;
      ringPx++;
      if (Math.abs(g[y * w + x]! - midBody) <= band) ringFlat++;
    }
  }

  // How often a row crosses between the two tones: blocks and letters do it constantly, a card
  // lying on a desk only twice.
  const mididx = (body + dark) / 2;
  let crossings = 0;
  for (let y = 0; y < h; y++) {
    let wasDark = g[y * w]! < mididx;
    for (let x = 1; x < w; x++) {
      const isDark = g[y * w + x]! < mididx;
      if (isDark !== wasDark) crossings++;
      wasDark = isDark;
    }
  }

  let edges = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = g[i + 1]! - g[i - 1]!;
      const gy = g[i + w]! - g[i - w]!;
      if (Math.abs(gx) + Math.abs(gy) > 70) edges++;
    }
  }

  return {
    flat: flat / n,
    centre: centreFlat / Math.max(1, mid.length),
    twoTone: twoTone / n,
    transitions: crossings / n,
    ink: ink / n,
    ring: ringFlat / Math.max(1, ringPx),
    edges: edges / n,
  };
}

/**
 * `ok` only for something card-like and properly placed. Everything else says what to do about it,
 * so the scanner never fires at a desk, a hand or the ceiling.
 */
export function placement(c: FrameCheck): Placement {
  // Flat with nothing printed on it: a table top, a wall, an empty sheet.
  if (c.ink < 0.012 && c.edges < 0.03) return 'blank';
  // A QR code or a barcode: two tones and nothing in between, blocks everywhere.
  if (c.twoTone > 0.85 && c.transitions > 0.05) return c.ring < 0.4 ? 'far' : 'ok';
  // Detail everywhere and no flat surface behind it: a desk, a keyboard, a room.
  if (c.edges > 0.35 && c.flat < 0.5) return 'none';
  // Nothing flat in the middle of the guide, so nothing is being held up to the camera.
  if (c.centre < 0.6) return 'none';
  // Something flat is there, but it does not fill the guide.
  if (c.ring < 0.55) return 'far';
  // A page of dense print — a leaflet or a screen — is not a business card.
  if (c.ink > 0.55) return 'none';
  return 'ok';
}

/** Index of the sharpest frame — burst capture keeps this one. Pure. */
export function pickSharpest(frames: Array<{ data: Uint8ClampedArray; w: number; h: number }>): number {
  let best = 0;
  let bestScore = -1;
  frames.forEach((f, i) => {
    const s = sharpness(f.data, f.w, f.h);
    if (s > bestScore) { bestScore = s; best = i; }
  });
  return best;
}

/** Blown-out white with almost no print: specular glare, not paper. Pure. */
export function isGlare(data: Uint8ClampedArray, w: number, h: number): boolean {
  const n = Math.max(1, w * h);
  let hot = 0;
  let ink = 0;
  for (let i = 0; i < n; i++) {
    const g = 0.299 * data[i * 4]! + 0.587 * data[i * 4 + 1]! + 0.114 * data[i * 4 + 2]!;
    if (g >= 250) hot++;
    else if (Math.abs(g - 235) > 40) ink++;
  }
  return hot / n > 0.12 && ink / n < 0.02;
}

/** Grab n frames gapMs apart from the live video, return the sharpest crop. */
export async function burstCrop(
  src: HTMLVideoElement, crop: { x: number; y: number; w: number; h: number }, n = 3, gapMs = 220,
): Promise<HTMLCanvasElement> {
  const shots: HTMLCanvasElement[] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, gapMs));
    if (!src.videoWidth) break;
    try {
      const c = document.createElement('canvas');
      c.width = Math.max(2, Math.round(crop.w));
      c.height = Math.max(2, Math.round(crop.h));
      c.getContext('2d')!.drawImage(src, crop.x, crop.y, crop.w, crop.h, 0, 0, c.width, c.height);
      shots.push(c);
    } catch {
      break;
    }
  }
  if (shots.length <= 1) return shots[0] ?? blankBurstCanvas();
  let best = shots[0]!;
  let bestScore = -1;
  const t = document.createElement('canvas');
  t.width = 80;
  t.height = 50;
  const tctx = t.getContext('2d', { willReadFrequently: true })!;
  for (const s of shots) {
    tctx.drawImage(s, 0, 0, 80, 50);
    const sc = sharpness(tctx.getImageData(0, 0, 80, 50).data, 80, 50);
    if (sc > bestScore) { bestScore = sc; best = s; }
  }
  return best;
}

function blankBurstCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 2;
  return c;
}
