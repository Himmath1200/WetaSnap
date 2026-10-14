import type { ReadResult } from './backend';
import type { FieldDefinition } from './types';

/**
 * Card reading order (client's choice): the local OCR service first (Surya/Tesseract on their
 * own machine — fast, free, data never leaves the network), then the cloud reader as a fallback,
 * then the on-device offline pack. See services/ocr for the local service.
 */
const KEY = 'wetasnap-ocr-url';
const DEFAULT_URL = import.meta.env.VITE_OCR_URL ?? '';

export const ocrUrl = () => (localStorage.getItem(KEY) ?? DEFAULT_URL).replace(/\/$/, '');
export const setOcrUrl = (url: string) => localStorage.setItem(KEY, url.trim().replace(/\/$/, ''));

/** What the service says about itself: which reading engines it has. */
export interface OcrHealth {
  ok: boolean;
  /** Engines the service reports as installed, e.g. ['Surya'] — empty means it cannot read a card. */
  engines: string[];
  version?: string;
}

let healthy: { at: number; health: OcrHealth } | null = null;

/** Cached for 60 s so a scan never waits on a dead service twice. */
export async function ocrHealth(force = false): Promise<OcrHealth> {
  const url = ocrUrl();
  if (!url) return { ok: false, engines: [] };
  if (!force && healthy && Date.now() - healthy.at < 60_000) return healthy.health;
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await r.json()) as {
      ok?: boolean; version?: string;
      engines?: { surya?: { installed?: boolean; error?: string | null }; tesseract?: { installed?: boolean } };
    };
    const engines: string[] = [];
    if (body.engines?.surya?.installed) engines.push('Surya');
    if (body.engines?.tesseract?.installed) engines.push('Tesseract');
    const health: OcrHealth = { ok: r.ok && body.ok === true, engines, version: body.version };
    healthy = { at: Date.now(), health };
    return health;
  } catch {
    const health: OcrHealth = { ok: false, engines: [] };
    healthy = { at: Date.now(), health };
    return health;
  }
}

/** True only when the service answers *and* has an engine that can read a card. */
export async function localOcrAvailable(force = false): Promise<boolean> {
  const h = await ocrHealth(force);
  return h.ok && h.engines.length > 0;
}

export async function readWithLocalOcr(photo: Blob, fields: FieldDefinition[], language = 'en'): Promise<ReadResult> {
  const url = ocrUrl();
  if (!url) throw new Error('No local OCR service configured');
  const image_base64 = await toBase64(photo);
  const r = await fetch(`${url}/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      image_base64, mime: photo.type || 'image/jpeg', language,
      fields: fields.map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options, ai_hint: f.ai_hint, required: f.required })),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`Local OCR failed (${r.status})`);
  const data = (await r.json()) as { fields: ReadResult };
  const out: ReadResult = {};
  for (const [k, v] of Object.entries(data.fields ?? {})) if (v?.value) out[k] = { ...v, by: 'offline' };
  return out;
}

function toBase64(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] ?? '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });
}
