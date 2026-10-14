/**
 * Steps 4 and 5: the OCR engine, and the AI extraction on top of it.
 *
 *   OCR        services/ocr (Surya or Tesseract) reads the card into the company's own fields,
 *              entirely on the machine it runs on. Nothing leaves the network.
 *   AI         when ANTHROPIC_API_KEY is set, Claude looks at the same image and fills what OCR
 *              could not — a name split across two lines, a job title in a stylised font — and
 *              gives a confidence for each value.
 *
 * Both are optional. With neither configured the pipeline still works: the app reads the card on
 * the device and sends the text, and the rules in extract.ts turn it into fields.
 */
import { Logger } from '@nestjs/common';
import { loadEnv } from '../../../common/env';

export interface FieldSpec { key: string; label: string; type: string; options: string[]; ai_hint: string; required: boolean }
export interface ReadValue { value: string; confidence: number; reason?: string }
export type ReadFields = Record<string, ReadValue>;

export interface ReadOutcome {
  fields: ReadFields;
  engine: string;
  text: string;
  ms: number;
}

const log = new Logger('Reader');

/** Is the local reader there? Cached briefly so a dead service is not probed on every card. */
let ocrAliveUntil = 0;
let ocrAlive = false;

export async function ocrAvailable(): Promise<boolean> {
  const { OCR_URL } = loadEnv();
  if (!OCR_URL) return false;
  if (Date.now() < ocrAliveUntil) return ocrAlive;
  try {
    const res = await fetch(`${OCR_URL.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(1500) });
    ocrAlive = res.ok;
  } catch {
    ocrAlive = false;
  }
  ocrAliveUntil = Date.now() + 30_000;
  return ocrAlive;
}

/** OCR through the local service. Returns no fields rather than throwing when it is not there. */
export async function readWithOcr(image: Buffer, mime: string, fields: FieldSpec[], language?: string): Promise<ReadOutcome | null> {
  const { OCR_URL } = loadEnv();
  if (!OCR_URL || !(await ocrAvailable())) return null;
  const started = Date.now();
  try {
    const res = await fetch(`${OCR_URL.replace(/\/$/, '')}/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        image_base64: image.toString('base64'),
        mime,
        fields: fields.map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options, ai_hint: f.ai_hint, required: f.required })),
        ...(language ? { language } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      log.warn(`local reader answered ${res.status}`);
      return null;
    }
    const body = await res.json() as { fields: ReadFields; engine: string; raw_text?: string };
    const fields = body.fields ?? {};
    return {
      fields,
      engine: body.engine ?? 'ocr',
      text: typeof body.raw_text === 'string' && body.raw_text.trim()
        ? body.raw_text
        : Object.values(fields).map((f) => f.value).join('\n'),
      ms: Date.now() - started,
    };
  } catch (e) {
    log.warn(`local reader failed: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Claude reads the card image directly. It is asked for strict JSON with one entry per field, a
 * confidence and a short reason when it is unsure — the same shape OCR returns, so the caller
 * does not care which produced a value.
 */
export async function readWithClaude(image: Buffer, mime: string, fields: FieldSpec[]): Promise<ReadOutcome | null> {
  const env = loadEnv();
  if (!env.ANTHROPIC_API_KEY) return null;
  const started = Date.now();

  const wanted = fields.map((f) => `- ${f.key} (${f.type})${f.label ? `: ${f.label}` : ''}${f.ai_hint ? ` — ${f.ai_hint}` : ''}`).join('\n');
  const prompt = `You are reading one business card photographed at a trade fair.
Fill only these fields, using exactly these keys:
${wanted}

Rules:
- Copy what is printed. Never invent, complete or translate a value.
- Leave a field out entirely if the card does not show it.
- confidence is 0 to 1: 1 when the text is unmistakable, below 0.7 when you had to guess.
- reason is a short note only when confidence is below 0.7, e.g. "handwritten", "cut off".
Answer with JSON only: {"fields": {"<key>": {"value": "...", "confidence": 0.0, "reason": "..."}}}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL,
        max_tokens: 1024,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime || 'image/jpeg', data: image.toString('base64') } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      log.warn(`Claude answered ${res.status}`);
      return null;
    }
    const body = await res.json() as { content: { type: string; text?: string }[] };
    const text = body.content?.find((c) => c.type === 'text')?.text ?? '';
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    const parsed = JSON.parse(json) as { fields?: Record<string, { value?: unknown; confidence?: unknown; reason?: unknown }> };
    const out: ReadFields = {};
    const allowed = new Set(fields.map((f) => f.key));
    for (const [key, value] of Object.entries(parsed.fields ?? {})) {
      if (!allowed.has(key)) continue;                 // never accept a field nobody asked for
      const v = String(value?.value ?? '').trim().slice(0, 500);
      if (!v) continue;
      out[key] = {
        value: v,
        confidence: clamp01(Number(value?.confidence ?? 0.8)),
        ...(value?.reason ? { reason: String(value.reason).slice(0, 200) } : {}),
      };
    }
    return { fields: out, engine: `claude:${env.ANTHROPIC_MODEL}`, text, ms: Date.now() - started };
  } catch (e) {
    log.warn(`Claude read failed: ${(e as Error).message}`);
    return null;
  }
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5);

/**
 * Merges what the readers found. The higher confidence wins, and a value a person already typed
 * is never overwritten by either of them (AI-04) — that rule lives in the pipeline, but this is
 * where the two machine answers meet.
 */
export function mergeReads(...reads: (ReadOutcome | null)[]): ReadFields {
  const out: ReadFields = {};
  for (const read of reads) {
    if (!read) continue;
    for (const [key, value] of Object.entries(read.fields)) {
      const have = out[key];
      if (!have || value.confidence > have.confidence + 0.05) out[key] = value;
    }
  }
  return out;
}
