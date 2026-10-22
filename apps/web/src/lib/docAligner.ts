/**
 * SCAN-V2 · DocAligner card-corner model (LCNet100-BiFPN, 256² input).
 *
 * The Pro scanner used to hunt contours with OpenCV + jscanify (~8 MB of CDN
 * script plus hand-tuned Canny thresholds). This is the learned version: one
 * 256×256 forward pass returns four sigmoid heatmaps, one blob per card corner,
 * which copes with clutter, hands and low contrast far better.
 *
 * Model contract (fixed, from the export):
 *   input  `img`     [1, 3, 256, 256] float32, BGR, pixel / 255
 *   output `heatmap` [1, 4, 256, 256] float32, sigmoid, channels = tl, tr, br, bl
 * There is no presence head, so absence shows up as a weak peak (see MIN_PEAK).
 *
 * Weight discipline (§8.1): ONNX Runtime's wasm build and the model load lazily,
 * only when the Pro scanner opens. Both are precached by the service worker
 * (`scripts/vendor-ort.mjs` copies the wasm into `public/ort/`), so the second
 * open — and a cold offline launch — still detects.
 */
import type { Pt, Quad } from './scanEngine';

const MODEL_URL = '/models/lcnet100_h_e_bifpn_256_fp32.onnx';
export const INPUT = 256;
/** Weakest of the four sigmoid peaks still accepted as a real corner. */
const MIN_PEAK = 0.45;

type OrtMod = typeof import('onnxruntime-web/wasm');

/** The slice of ORT's surface this module needs. */
interface Session {
  inputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
}

interface Loaded { ort: OrtMod; session: Session }

let loadPromise: Promise<Loaded> | null = null;

/** BGR, /255, NCHW — what the export was trained on. Pure: unit-tested. */
export function toInput(rgba: Uint8ClampedArray | Uint8Array): Float32Array {
  const n = INPUT * INPUT;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[i] = rgba[i * 4 + 2]! / 255;      // B
    out[n + i] = rgba[i * 4 + 1]! / 255;  // G
    out[2 * n + i] = rgba[i * 4]! / 255;  // R
  }
  return out;
}

/**
 * Per-channel argmax → one corner each, in the model's channel order, plus the
 * weakest peak as the confidence. Pure: unit-tested.
 */
export function cornersFromHeatmap(heat: Float32Array, size = INPUT): { pts: Pt[]; confidence: number } {
  const pts: Pt[] = [];
  let confidence = 1;
  for (let c = 0; c < 4; c++) {
    const off = c * size * size;
    let best = -Infinity;
    let bi = 0;
    for (let i = 0; i < size * size; i++) {
      const v = heat[off + i]!;
      if (v > best) { best = v; bi = i; }
    }
    confidence = Math.min(confidence, best);
    // +0.5 → the centre of the hottest cell, not its top-left pixel.
    pts.push({ x: (bi % size) + 0.5, y: Math.floor(bi / size) + 0.5 });
  }
  return { pts, confidence };
}

/**
 * Loads ORT + the model once. The wasm runtime is vendored next to the app so a
 * precached build never reaches for the network. A failure stays retryable.
 */
export function loadAligner(): Promise<Loaded> {
  if (!loadPromise) {
    loadPromise = (async () => {
      const ort = await import('onnxruntime-web/wasm');
      ort.env.wasm.wasmPaths = '/ort/';
      // Multi-threaded wasm needs SharedArrayBuffer (COOP/COEP) which static hosts
      // do not send, and one thread is plenty for a single 256×256 inference.
      ort.env.wasm.numThreads = 1;
      const session = (await ort.InferenceSession.create(MODEL_URL, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      })) as unknown as Session;
      return { ort, session };
    })();
    void loadPromise.catch(() => { loadPromise = null; });
  }
  return loadPromise;
}

/** Warm the model while the person aims the camera. */
export function warmAligner() {
  void loadAligner().catch(() => { /* the screen surfaces the error state */ });
}

/**
 * Corners for one frame, in the caller's pixel space, or null when the model is
 * not confident there is a card. Throws only when the engine cannot load.
 */
export async function detectCorners(src: CanvasImageSource, sw: number, sh: number): Promise<Quad | null> {
  const { ort, session } = await loadAligner();
  const frame = document.createElement('canvas');
  frame.width = INPUT;
  frame.height = INPUT;
  const ctx = frame.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(src, 0, 0, INPUT, INPUT);
  const px = ctx.getImageData(0, 0, INPUT, INPUT);
  const tensor = new ort.Tensor('float32', toInput(px.data), [1, 3, INPUT, INPUT]);
  const out = await session.run({ [session.inputNames[0] ?? 'img']: tensor });
  const heat = Object.values(out)[0]?.data;
  if (!heat) return null;
  const { pts, confidence } = cornersFromHeatmap(heat);
  if (confidence < MIN_PEAK) return null;
  const kx = sw / INPUT;
  const ky = sh / INPUT;
  const [tl, tr, br, bl] = pts as [Pt, Pt, Pt, Pt];
  const at = (p: Pt): Pt => ({ x: p.x * kx, y: p.y * ky });
  return { tl: at(tl), tr: at(tr), br: at(br), bl: at(bl) };
}
