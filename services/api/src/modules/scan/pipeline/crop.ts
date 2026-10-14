/**
 * Step 3: crop to the card.
 *
 * Two ways in. The app sends the rectangle the person dragged on the "Crop / adjust" screen, and
 * that is used as given — their eyes beat any heuristic. When nothing is sent (an uploaded photo,
 * a background re-read), the card is found here: the frame is reduced to edge energy, the busy
 * region is taken as the card, and a small margin is added back so nothing is shaved off.
 *
 * Cropping before OCR matters more than it sounds: a card that fills 30 % of a photo gets three
 * times the resolution once the lanyard, the table and the hand around it are gone.
 */
import sharp from 'sharp';

export interface CropRect { x: number; y: number; w: number; h: number; rotate?: number }

export interface CropResult {
  image: Buffer;
  applied: CropRect | null;
  width: number;
  height: number;
  /** 'person' when the app sent the rectangle, 'auto' when it was found here. */
  by: 'person' | 'auto' | 'none';
}

/** The long edge the reader gets. More than this costs time without reading any better. */
const TARGET_LONG_EDGE = 1600;

export async function cropCard(image: Buffer, asked?: CropRect | null): Promise<CropResult> {
  const base = sharp(image, { failOn: 'none' }).rotate();
  const meta = await base.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) return { image, applied: null, width, height, by: 'none' };

  const rect = asked ? clampRect(asked, width, height) : await findCard(base.clone(), width, height);
  let pipeline = sharp(image, { failOn: 'none' }).rotate();
  if (rect) pipeline = pipeline.extract({ left: rect.x, top: rect.y, width: rect.w, height: rect.h });
  if (asked?.rotate) pipeline = pipeline.rotate(((asked.rotate % 360) + 360) % 360);

  const out = await pipeline
    .resize(TARGET_LONG_EDGE, TARGET_LONG_EDGE, { fit: 'inside', withoutEnlargement: true })
    // A card is text on paper: a touch of sharpening and a flat background read better.
    .normalise()
    .sharpen({ sigma: 0.6 })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  return {
    image: out.data,
    applied: rect,
    width: out.info.width,
    height: out.info.height,
    by: asked ? 'person' : rect ? 'auto' : 'none',
  };
}

/** Re-encodes without cropping — used for the back of a card and for stored originals. */
export async function normaliseImage(image: Buffer): Promise<{ image: Buffer; width: number; height: number }> {
  const out = await sharp(image, { failOn: 'none' })
    .rotate()
    .resize(TARGET_LONG_EDGE, TARGET_LONG_EDGE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 86, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { image: out.data, width: out.info.width, height: out.info.height };
}

/** The busy rectangle in the middle of the frame, or null when there is no clear one. */
async function findCard(base: sharp.Sharp, width: number, height: number): Promise<CropRect | null> {
  const { data, info } = await base
    .greyscale()
    .resize(320, 320, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const cols = new Float32Array(w);
  const rows = new Float32Array(h);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      const gx = Math.abs(data[i + 1]! - data[i - 1]!);
      const gy = Math.abs(data[i + w]! - data[i - w]!);
      if (gx + gy > 30) {
        cols[x] = (cols[x] ?? 0) + 1;
        rows[y] = (rows[y] ?? 0) + 1;
      }
    }
  }

  const horizontal = bounds(cols, w);
  const vertical = bounds(rows, h);
  if (!horizontal || !vertical) return null;

  // Back to the original's pixels, with a 3 % margin so no edge of the card is lost.
  const scaleX = width / w;
  const scaleY = height / h;
  const marginX = Math.round(width * 0.03);
  const marginY = Math.round(height * 0.03);
  const rect = {
    x: Math.round(horizontal.from * scaleX) - marginX,
    y: Math.round(vertical.from * scaleY) - marginY,
    w: Math.round((horizontal.to - horizontal.from + 1) * scaleX) + marginX * 2,
    h: Math.round((vertical.to - vertical.from + 1) * scaleY) + marginY * 2,
  };
  const clamped = clampRect(rect, width, height);
  if (!clamped) return null;
  // Not worth it if it barely crops anything, or if it found something implausibly small.
  const area = (clamped.w * clamped.h) / (width * height);
  return area > 0.9 || area < 0.12 ? null : clamped;
}

function bounds(counts: Float32Array, length: number): { from: number; to: number } | null {
  let total = 0;
  for (const v of counts) total += v;
  if (total < length) return null;
  const threshold = (total / length) * 0.4;
  let from = -1;
  let to = -1;
  for (let i = 0; i < length; i += 1) {
    if ((counts[i] ?? 0) >= threshold) {
      if (from < 0) from = i;
      to = i;
    }
  }
  return from < 0 || to - from < length * 0.15 ? null : { from, to };
}

function clampRect(rect: CropRect, width: number, height: number): CropRect | null {
  const x = Math.max(0, Math.min(Math.round(rect.x), width - 1));
  const y = Math.max(0, Math.min(Math.round(rect.y), height - 1));
  const w = Math.max(1, Math.min(Math.round(rect.w), width - x));
  const h = Math.max(1, Math.min(Math.round(rect.h), height - y));
  if (w < 32 || h < 32) return null;
  return { x, y, w, h };
}
