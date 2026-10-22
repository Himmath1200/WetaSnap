/**
 * Copies the ONNX Runtime wasm + its ESM glue into `ort/` (runs on `dev` and
 * `build`). `src/lib/docAligner.ts` imports both with `?url`, so Vite emits
 * hashed assets the service worker can precache (offline detection).
 *
 * Not `public/`: ORT imports the glue as a module at runtime, and Vite refuses to
 * serve public files through the module graph. An 11 MB binary does not belong
 * in git either, so it is rebuilt from the installed package. The model itself
 * (`public/models/*.onnx`) is a real asset and is committed.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'ort');
const files = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'];

// `onnxruntime-web/package.json` is not in the package's exports map, so resolve the
// entry point instead and walk up to the folder that holds the wasm.
let dist;
try {
  let dir = dirname(createRequire(import.meta.url).resolve('onnxruntime-web'));
  for (let i = 0; i < 4 && !existsSync(join(dir, 'dist', 'ort-wasm-simd-threaded.wasm')); i++) dir = dirname(dir);
  dist = join(dir, 'dist');
} catch {
  console.warn('[vendor-ort] onnxruntime-web is not installed — the Pro scanner will not detect cards.');
  process.exit(0);
}

mkdirSync(out, { recursive: true });
for (const f of files) {
  const from = join(dist, f);
  const to = join(out, f);
  if (!existsSync(from)) { console.warn(`[vendor-ort] missing ${f} in onnxruntime-web/dist`); continue; }
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
  copyFileSync(from, to);
}
