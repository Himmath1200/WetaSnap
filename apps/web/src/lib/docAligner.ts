/**
 * SCAN-V2 · card corners from DocAligner's lightweight detector.
 *
 * Model: `lcnet100_h_e_bifpn_256_fp32.onnx` — PP-LCNet100 backbone + BiFPN neck,
 * 1.19 M params, 4.5 MB fp32, from DocAligner (https://github.com/DocsaidLab/DocAligner,
 * Apache-2.0). It lives in `public/models/` as a build asset, not as code.
 *
 * Contract: input `img` [1,3,256,256] float32, BGR, /255; output `heatmap`
 * [1,4,256,256] sigmoid — one corner per channel in TL, TR, BR, BL order.
 * The export has no presence head, so a blank frame still yields four weak blobs:
 * `cornersFromHeatmap` refuses anything without a real peak and `detectCard`
 * adds the card-shape guards on top.
 *
 * Weight (§8.1): this module and the ORT runtime load only when the Pro scanner
 * opens. The `onnxruntime-web/wasm` build carries its wasm inline, so the whole
 * engine is one lazy chunk plus the model file — nothing in the first download.
 */
import type * as Ort from 'onnxruntime-web/wasm';
import type { Pt, Quad } from './scanEngine';

/** Square input the export was trained on. */
export const INPUT = 256;
/** Upstream's own cut-off for a corner heatmap. */
export const HEAT_THRESHOLD = 0.3;
/** …and ours on top: a blob's peak must reach this or there is no card. */
const MIN_PEAK = 0.3;
/** Blobs below a few pixels are noise, not a corner. */
const MIN_BLOB = 6;

const MODEL_URL = '/models/lcnet100_h_e_bifpn_256_fp32.onnx';

let engine: Promise<{ ort: typeof import('onnxruntime-web/wasm'); session: Ort.InferenceSession }> | null = null;

function load() {
  if (!engine) {
    engine = (async () => {
      const ort = await import('onnxruntime-web/wasm');
      // The runtime is vendored into public/ort by scripts/vendor-ort.mjs: precached
      // by the service worker, so a cold offline launch still detects cards.
      ort.env.wasm.wasmPaths = '/ort/';
      // Multi-threaded wasm needs SharedArrayBuffer (COOP/COEP headers) which static
      // hosts do not send, and one thread is plenty for a 256×256 model.
      ort.env.wasm.numThreads = 1;
      const session = await ort.InferenceSession.create(MODEL_URL, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      return { ort, session };
    })();
    // A failed load must be retryable (cache flushed, host blipped).
    void engine.catch(() => { engine = null; });
  }
  return engine;
}

/** Downloads the model and builds the session while the person is still aiming. */
export function warmModel(): Promise<unknown> {
  return load();
}

/**
 * RGBA pixels → the model's input: three 256×256 planes, BGR order, scaled 0–1.
 * Nearest-neighbour sampling is enough — the export wants a plain 256×256 resize.
 * Pure: unit-tested.
 */
export function preprocess(rgba: Uint8ClampedArray, w: number, h: number): Float32Array {
  const out = new Float32Array(3 * INPUT * INPUT);
  for (let y = 0; y < INPUT; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / INPUT));
    for (let x = 0; x < INPUT; x++) {
      const i = (sy * w + Math.min(w - 1, Math.floor((x * w) / INPUT))) * 4;
      const o = y * INPUT + x;
      out[o] = rgba[i + 2]! / 255;
      out[INPUT * INPUT + o] = rgba[i + 1]! / 255;
      out[2 * INPUT * INPUT + o] = rgba[i]! / 255;
    }
  }
  return out;
}

/**
 * Strongest blob per channel → one corner: threshold, take the connected blob with
 * the most heat, average its pixels (upstream's own recipe). Null when any channel
 * has no confident peak. Pure: unit-tested.
 */
export function cornersFromHeatmap(heat: ArrayLike<number>, size = INPUT): Quad | null {
  const n = size * size;
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  const pts: Pt[] = [];
  for (let c = 0; c < 4; c++) {
    const off = c * n;
    seen.fill(0);
    let bestW = 0;
    let bx = 0;
    let by = 0;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      if (seen[i] || (heat[off + i] ?? 0) < HEAT_THRESHOLD) continue;
      let wsum = 0;
      let ax = 0;
      let ay = 0;
      let area = 0;
      let top = 0;
      stack.length = 0;
      stack.push(i);
      seen[i] = 1;
      while (stack.length) {
        const p = stack.pop()!;
        const v = heat[off + p] ?? 0;
        const px = p % size;
        const py = (p - px) / size;
        wsum += v;
        ax += px * v;
        ay += py * v;
        area++;
        if (v > top) top = v;
        const push = (j: number) => {
          if (!seen[j] && (heat[off + j] ?? 0) >= HEAT_THRESHOLD) { seen[j] = 1; stack.push(j); }
        };
        if (px > 0) push(p - 1);
        if (px < size - 1) push(p + 1);
        if (p >= size) push(p - size);
        if (p < n - size) push(p + size);
      }
      if (area >= MIN_BLOB && wsum > bestW) { bestW = wsum; bx = ax / wsum; by = ay / wsum; peak = top; }
    }
    if (bestW === 0 || peak < MIN_PEAK) return null;
    pts.push({ x: bx, y: by });
  }
  return { tl: pts[0]!, tr: pts[1]!, br: pts[2]!, bl: pts[3]! };
}

/**
 * Runs the detector on anything drawable (video, canvas, bitmap). Corners come back
 * in the 256-grid's own pixel space; callers scale to their frame.
 */
export async function inferCorners(src: CanvasImageSource): Promise<Quad | null> {
  const { ort, session } = await load();
  const c = document.createElement('canvas');
  c.width = INPUT;
  c.height = INPUT;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, INPUT, INPUT);
  const pixels = ctx.getImageData(0, 0, INPUT, INPUT).data;
  const feed = new ort.Tensor('float32', preprocess(pixels, INPUT, INPUT), [1, 3, INPUT, INPUT]);
  const out = await session.run({ [session.inputNames[0]!]: feed });
  const heat = out[session.outputNames[0]!];
  if (!heat) return null;
  return cornersFromHeatmap(heat.data as Float32Array, INPUT);
}
