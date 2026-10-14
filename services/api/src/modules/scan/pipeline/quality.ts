/**
 * Step 2 of the pipeline: is this image worth reading?
 *
 * A blurred, dark or half-missing card wastes an OCR pass and, worse, produces a lead full of
 * wrong details that somebody has to correct later. Four measurements decide, each with a plain
 * reason so the app can say what to do differently rather than just "poor quality":
 *
 *   sharpness  variance of a Laplacian — a blurred photo has almost none
 *   exposure   mean brightness, plus how much of the frame is clipped to pure black or white
 *   glare      near-white pixels, which is flash bounced off a laminated card
 *   coverage   how much of the frame the card itself fills, from where the detail is
 *
 * The same numbers are stored with the card (business_cards.quality), so a lead that came out
 * wrong can be explained afterwards.
 */
import sharp from 'sharp';

export interface Quality {
  sharpness: number;   // 0..1
  exposure: number;    // 0..1 mean brightness
  clipped: number;     // 0..1 share of pure black / pure white
  glare: number;       // 0..1 share of near-white
  coverage: number;    // 0..1 how much of the frame holds detail
  width: number;
  height: number;
  verdict: 'good' | 'poor';
  reasons: string[];
}

/** Below these, reading the card is not worth the attempt. */
const MIN_SHARPNESS = 0.08;
const MIN_COVERAGE = 0.25;
const DARK = 0.18;
const BRIGHT = 0.92;
// A white business card is mostly bright by nature, so glare only counts when the frame is
// genuinely blown out: more than half of it clipped AND the whole image very bright.
const MAX_GLARE = 0.5;
const GLARE_NEEDS_EXPOSURE = 0.75;
const MIN_PIXELS = 400;       // a card smaller than this in the long edge cannot be read

export async function measure(image: Buffer): Promise<Quality> {
  const base = sharp(image, { failOn: 'none' }).rotate();          // honour the EXIF rotation
  const meta = await base.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  // Work on a small grey copy: the numbers are about structure, not detail, and this keeps a
  // 12-megapixel phone photo from costing half a second.
  const { data, info } = await base
    .clone()
    .greyscale()
    .resize(320, 320, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = data.length;
  let sum = 0;
  let dark = 0;
  let white = 0;
  let nearWhite = 0;
  for (let i = 0; i < pixels; i += 1) {
    const v = data[i]!;
    sum += v;
    if (v <= 4) dark += 1;
    else if (v >= 250) white += 1;
    if (v >= 250) nearWhite += 1;
  }
  const exposure = sum / pixels / 255;
  const clipped = (dark + white) / pixels;
  const glare = nearWhite / pixels;

  // Laplacian over the small image: |4·p − neighbours|, then its variance.
  const w = info.width;
  const h = info.height;
  let edgeSum = 0;
  let edgeSquares = 0;
  let edgeCount = 0;
  const columnEdges = new Float32Array(w);
  const rowEdges = new Float32Array(h);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      const lap = Math.abs(4 * data[i]! - data[i - 1]! - data[i + 1]! - data[i - w]! - data[i + w]!);
      edgeSum += lap;
      edgeSquares += lap * lap;
      edgeCount += 1;
      if (lap > 24) {                   // a real edge, not sensor noise
        columnEdges[x] = (columnEdges[x] ?? 0) + 1;
        rowEdges[y] = (rowEdges[y] ?? 0) + 1;
      }
    }
  }
  const mean = edgeSum / Math.max(1, edgeCount);
  const variance = edgeSquares / Math.max(1, edgeCount) - mean * mean;
  // 2000 is roughly where a hand-held phone photo of a card sits when it is in focus.
  const sharpness = clamp(Math.sqrt(Math.max(0, variance)) / 45);

  const coverage = clamp(span(columnEdges, w) * span(rowEdges, h));

  const reasons: string[] = [];
  if (Math.max(width, height) < MIN_PIXELS) reasons.push('Hold the camera closer — the card is too small in the frame.');
  if (sharpness < MIN_SHARPNESS) reasons.push('Hold still for a moment — the photo is blurred.');
  if (exposure < DARK) reasons.push('There is not enough light on the card.');
  if (exposure > BRIGHT || (glare > MAX_GLARE && exposure > GLARE_NEEDS_EXPOSURE)) {
    reasons.push('Move the card out of the direct light — it is reflecting.');
  }
  if (coverage < MIN_COVERAGE) reasons.push('Fill more of the frame with the card.');

  return {
    sharpness: round(sharpness), exposure: round(exposure), clipped: round(clipped), glare: round(glare),
    coverage: round(coverage), width, height,
    verdict: reasons.length ? 'poor' : 'good',
    reasons,
  };
}

/** How much of one axis holds detail: the span between the first and last busy line. */
function span(counts: Float32Array, length: number): number {
  const threshold = Math.max(2, average(counts) * 0.35);
  let first = -1;
  let last = -1;
  for (let i = 0; i < length; i += 1) {
    if ((counts[i] ?? 0) >= threshold) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return first < 0 ? 0 : (last - first + 1) / length;
}

const average = (a: Float32Array) => {
  let s = 0;
  for (const v of a) s += v;
  return s / Math.max(1, a.length);
};

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const round = (v: number) => Math.round(v * 1000) / 1000;
