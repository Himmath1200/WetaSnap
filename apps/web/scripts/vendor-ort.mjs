/**
 * Copies the ONNX Runtime wasm runtime into `public/ort/` so the Pro scanner's
 * detector can be precached and run offline.
 *
 * ORT ships that wasm next to its JS inside `node_modules`, which Vite does not
 * copy (it is fetched at runtime, not imported). An 11 MB binary has no business
 * in git either, so it is rebuilt from the installed package on dev/build.
 * The model file (`public/models/*.onnx`) is a real asset and is committed.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'public', 'ort');
const files = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'];

let dist;
try {
  dist = join(dirname(createRequire(import.meta.url).resolve('onnxruntime-web/package.json')), 'dist');
} catch {
  console.warn('[vendor-ort] onnxruntime-web is not installed — the Pro scanner will not detect cards.');
  process.exit(0);
}

mkdirSync(out, { recursive: true });
for (const f of files) {
  const from = join(dist, f);
  const to = join(out, f);
  if (!existsSync(from)) {
    console.warn(`[vendor-ort] ${f} is missing from onnxruntime-web@dist`);
    continue;
  }
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
  copyFileSync(from, to);
}
