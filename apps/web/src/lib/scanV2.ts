/**
 * SCAN-V2 · from the flat warp to the lead photo.
 *
 * scanEngine.ts owns the geometry (model corners + our own homography warp).
 * Everything after the warp reuses the classic pipeline, so the two scanners
 * can never drift apart: the look (`autoEnhance`: flatten → level → punch),
 * the ≤ 420 KB compression, and the reading flow downstream of it.
 */
import { autoEnhance, sauvolaBinarize } from './scan';
import { compressCard } from './image';

/** CamScanner-style looks. Colour is the default; grey/B&W help tired print. */
export type ScanFilter = 'color' | 'gray' | 'bw';

export async function blobToCanvas(photo: Blob): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(photo);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}

/** Grey flattens to luminance; B&W binarises with the same Sauvola pass the OCR pre-pass uses. Pure canvas work. */
export function applyFilter(src: HTMLCanvasElement, mode: ScanFilter): HTMLCanvasElement {
  if (mode === 'color') return src;
  const w = src.width;
  const h = src.height;
  const ctx = src.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  if (mode === 'gray') {
    for (let i = 0; i < d.length; i += 4) {
      const g = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
      d[i] = g; d[i + 1] = g; d[i + 2] = g;
    }
  } else {
    const gray = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) gray[i] = 0.299 * d[i * 4]! + 0.587 * d[i * 4 + 1]! + 0.114 * d[i * 4 + 2]!;
    const bw = sauvolaBinarize(gray, w, h);
    for (let i = 0; i < w * h; i++) {
      const v = bw[i]!;
      d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v;
    }
  }
  ctx.putImageData(img, 0, 0);
  return src;
}

/**
 * Warped card → lead photo: filter, then the shared clean-up + compression.
 * Falls back to plain compression when enhancement fails — a photo always wins
 * over an error.
 */
export async function developScan(warped: HTMLCanvasElement, mode: ScanFilter): Promise<Blob> {
  const cleaned = applyFilter(warped, mode);
  try {
    // The warp already cut the card out: no second detection, or it shaves printed lines.
    return await autoEnhance(cleaned, false); // canvas in: one encode, not a JPEG round-trip first
  } catch {
    return compressCard(cleaned);
  }
}
