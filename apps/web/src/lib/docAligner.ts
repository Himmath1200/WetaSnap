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
 *   output `heatmap` [1, 4, 128, 128] float32, sigmoid, channels = tl, tr, br, bl
 *   (the grid is half the input — always read its size from the tensor dims)
 * There is no presence head, so absence shows up as a weak peak (see MIN_PEAK).
 *
 * Weight discipline (§8.1): ONNX Runtime's wasm build and the model load lazily,
 * only when the Pro scanner opens. Both are precached by the service worker
 * (`scripts/vendor-ort.mjs` copies the wasm + glue into `ort/`, imported here as
 * `?url` assets), so the second open — and a cold offline launch — still detects.
 */
import wasmUrl from '../../ort/ort-wasm-simd-threaded.wasm?url';
import glueUrl from '../../ort/ort-wasm-simd-threaded.mjs?url';
import type { Pt, Quad } from './scanEngine';

const MODEL_URL = '/models/lcnet100_h_e_bifpn_256_fp32.onnx';
export const INPUT = 256;
/** Weakest of the four sigmoid peaks still accepted as a real corner. */
const MIN_PEAK = 0.45;

type OrtMod = typeof import('onnxruntime-web/wasm');

/** The slice of ORT's surface this module needs. */
interface Session {
  inputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims?: readonly number[] }>>;
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
      // Both files as real assets: ORT imports the glue as a module at runtime.
      ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: glueUrl };
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
  const first = Object.values(out)[0];
  const heat = first?.data;
  if (!heat) return null;
  // The export's heatmap grid is coarser than the input (128² for a 256² input),
  // so the stride comes from the tensor, never from INPUT.
  const grid = first?.dims?.at(-1) ?? INPUT;
  const { pts, confidence } = cornersFromHeatmap(heat, grid);
  if (confidence < MIN_PEAK) {
    if (import.meta.env.DEV) {
      // Temporary: channel order and normalisation are guesses — measure them.
      const n = INPUT * INPUT;
      const mean = [0.485, 0.456, 0.406];
      const std = [0.229, 0.224, 0.225];
      const probe = async (label: string, order: [number, number, number], norm: boolean) => {
        const t = new Float32Array(3 * n);
        for (let i = 0; i < n; i++) {
          for (let ch = 0; ch < 3; ch++) {
            const v = px.data[i * 4 + order[ch]!]! / 255;
            t[ch * n + i] = norm ? (v - mean[ch]!) / std[ch]! : v;
          }
        }
        const r = await session.run({ [session.inputNames[0] ?? 'img']: new ort.Tensor('float32', t, [1, 3, INPUT, INPUT]) });
        const h = Object.values(r)[0]?.data;
        return [label, h ? Number(cornersFromHeatmap(h, grid).confidence.toFixed(4)) : null] as const;
      };
      const probes = Object.fromEntries([
        await probe('bgrRaw', [2, 1, 0], false),
        await probe('rgbRaw', [0, 1, 2], false),
        await probe('bgrNorm', [2, 1, 0], true),
        await probe('rgbNorm', [0, 1, 2], true),
      ]);
      console.warn('[aligner] low peak', { grid, bgrPeak: confidence, probes, max: heat.reduce((m, v) => (v > m ? v : m), 0) });
    }
    return null;
  }
  const kx = sw / grid;
  const ky = sh / grid;
  const [tl, tr, br, bl] = pts as [Pt, Pt, Pt, Pt];
  const at = (p: Pt): Pt => ({ x: p.x * kx, y: p.y * ky });
  return { tl: at(tl), tr: at(tr), br: at(br), bl: at(bl) };
}
