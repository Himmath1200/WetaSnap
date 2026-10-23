/**
 * Step 3: crop to the rectangle the app took.
 *
 * The app is the only place the card is ever cut: it sees the frame, warps the card flat and the
 * person true-ups the corners. The server applies that rectangle as given — their eyes beat any
 * heuristic — and when nothing is sent it re-encodes without cutting. Guessing a card boundary
 * here on an already-cropped photo shaved printed lines off the card, in the OCR input and in the
 * copy kept in storage.
 */
import sharp from 'sharp';

export interface CropRect { x: number; y: number; w: number; h: number; rotate?: number }

export interface CropResult {
  image: Buffer;
  applied: CropRect | null;
  width: number;
  height: number;
  /** 'person' when the app sent the rectangle, 'none' when the image was kept whole. */
  by: 'person' | 'none';
}

/** The long edge the reader gets. More than this costs time without reading any better. */
const TARGET_LONG_EDGE = 1600;

export async function cropCard(image: Buffer, asked?: CropRect | null): Promise<CropResult> {
  const base = sharp(image, { failOn: 'none' }).rotate();
  const meta = await base.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) return { image, applied: null, width, height, by: 'none' };

  const rect = asked ? clampRect(asked, width, height) : null;
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
    by: rect ? 'person' : 'none',
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

function clampRect(rect: CropRect, width: number, height: number): CropRect | null {
  const x = Math.max(0, Math.min(Math.round(rect.x), width - 1));
  const y = Math.max(0, Math.min(Math.round(rect.y), height - 1));
  const w = Math.max(1, Math.min(Math.round(rect.w), width - x));
  const h = Math.max(1, Math.min(Math.round(rect.h), height - y));
  if (w < 32 || h < 32) return null;
  return { x, y, w, h };
}
