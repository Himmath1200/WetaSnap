/**
 * SCAN-V2 · from the flat warp to the lead photo.
 *
 * jscanify owns the geometry (corners + perspective warp in scanEngine.ts).
 * Everything after the warp reuses the classic pipeline, so the two scanners
 * can never drift apart: the look (`autoEnhance`: flatten → level → punch),
 * the ≤ 300 KB compression, and the reading flow downstream of it.
 */
import { autoEnhance, sauvolaBinarize } from './scan';
import { compressCard } from './image';

/** CamScanner-style looks. Colour is the default; grey/B&W help tired print. */
export type ScanFilter = 'color' | 'gray' | 'bw';

export function canvasToBlob(c: HTMLCanvasElement, type = 'image/jpeg', q = 0.92): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), type, q));
}

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
  const raw = await canvasToBlob(applyFilter(warped, mode));
  try {
    return await autoEnhance(raw);
  } catch {
    return compressCard(raw);
  }
}
