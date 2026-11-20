import type { FieldDefinition } from './types';
import type { ReadResult } from './backend';
import { isOnline } from './net';

export const GEMINI_MODELS = [
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite' },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
  { id: 'gemini-3-flash', label: 'Gemini 3 Flash' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
  { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
] as const;

export type GeminiModelId = typeof GEMINI_MODELS[number]['id'];

const STORAGE_KEY = 'wetasnap-gemini-key';
const MODEL_STORAGE_KEY = 'wetasnap-gemini-model';
const DEFAULT_MODEL: GeminiModelId = (import.meta.env.VITE_GEMINI_MODEL as GeminiModelId) || 'gemini-3.5-flash-lite';

const safeStorage = {
  get: (k: string): string | null => {
    try { return typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null; } catch { return null; }
  },
  set: (k: string, v: string): void => {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); } catch {}
  },
  remove: (k: string): void => {
    try { if (typeof localStorage !== 'undefined') localStorage.removeItem(k); } catch {}
  },
};

export const geminiApiKey = (): string => {
  const stored = safeStorage.get(STORAGE_KEY);
  if (stored !== null) return stored.trim();
  return (import.meta.env.VITE_GEMINI_API_KEY ?? '').trim();
};
export const setGeminiApiKey = (key: string): void => {
  safeStorage.set(STORAGE_KEY, key.trim());
};

export const geminiModel = (): GeminiModelId => {
  const saved = safeStorage.get(MODEL_STORAGE_KEY) as GeminiModelId | null;
  if (saved && GEMINI_MODELS.some((m) => m.id === saved)) return saved;
  return DEFAULT_MODEL;
};

export const setGeminiModel = (model: GeminiModelId): void => {
  safeStorage.set(MODEL_STORAGE_KEY, model);
};

/** True when the user is online AND a Gemini API key is configured. */
export function geminiAvailable(): boolean {
  return isOnline() && Boolean(geminiApiKey());
}

/** Check if any field in the OCR result has low confidence (< 0.8) or is a critical missing field. */
export function hasLowConfidenceField(
  result: ReadResult,
  minConfidence = 0.8,
): boolean {
  const entries = Object.entries(result);
  if (!entries.length) return true;

  // Check if any existing field has low confidence
  for (const [, v] of entries) {
    if (v && v.value && (v.confidence ?? 1) < minConfidence) {
      return true;
    }
  }

  // Check if primary business card fields are missing
  const hasName = Boolean(result.first_name?.value || result.name?.value);
  const hasCompany = Boolean(result.company?.value);
  const hasContact = Boolean(result.email?.value || result.phone?.value);

  return !hasName || !hasCompany || !hasContact;
}

function toBase64(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] ?? '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });
}

/**
 * Verify and correct low-confidence OCR fields using Google Gemini AI.
 * Runs strictly in online mode when Gemini is configured and at least one field has low confidence.
 * Uses selected Gemini model (e.g. Gemini 3.5 Flash Lite, Gemini 3 Flash, etc.).
 */
export async function verifyLowConfidenceWithGemini(
  photo: Blob | null,
  currentFields: ReadResult,
  fieldDefs: FieldDefinition[],
  customOcrText?: string,
): Promise<ReadResult> {
  if (!geminiAvailable()) return currentFields;
  if (!hasLowConfidenceField(currentFields, 0.8)) return currentFields;

  const apiKey = geminiApiKey();
  const modelId = geminiModel();
  const rawText = customOcrText || '';

  try {
    const parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> = [];

    // Attach card image if available
    if (photo) {
      const base64Image = await toBase64(photo);
      parts.push({
        inline_data: {
          mime_type: photo.type || 'image/jpeg',
          data: base64Image,
        },
      });
    }

    const fieldListStr = fieldDefs
      .map((f) => `- ${f.key} (${f.label}, type: ${f.type}${f.options?.length ? `, options: ${f.options.join('/')}` : ''})`)
      .join('\n');

    const candidateSummary = Object.entries(currentFields)
      .map(([k, v]) => `${k}: "${v?.value ?? ''}" (confidence: ${v?.confidence ?? 0})`)
      .join('\n');

    const promptText = `You are a business card OCR verification assistant.
Analyze this business card image and/or raw OCR text to verify and correct field extraction.
Target fields to identify:
${fieldListStr}

Current OCR candidate extraction (some fields have low confidence or errors):
${candidateSummary || '(empty)'}

Raw OCR Text:
${rawText || '(none)'}

Instructions:
1. Extract accurate, clean values for each field found on the card.
2. Correct OCR typos in names, emails, phone numbers, website URLs, and company names.
3. For each field found, assign a confidence score between 0.85 and 0.99.
4. Output strictly valid JSON with this structure (no markdown, no extra text):
{
  "fields": {
    "first_name": { "value": "Jane", "confidence": 0.96 },
    "last_name": { "value": "Doe", "confidence": 0.96 },
    "job_title": { "value": "Chief Technology Officer", "confidence": 0.94 },
    "company": { "value": "Acme Corp", "confidence": 0.95 },
    "email": { "value": "jane@acme.com", "confidence": 0.98 },
    "phone": { "value": "+1 555-0199", "confidence": 0.95 }
  }
}`;

    parts.push({ text: promptText });

    const requestBody = JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        temperature: 0.1,
        response_mime_type: 'application/json',
      },
    });

    const candidateModels: GeminiModelId[] = [
      modelId,
      ...GEMINI_MODELS.map((m) => m.id).filter((id) => id !== modelId),
    ];

    let response: Response | null = null;
    let usedModel: GeminiModelId = modelId;

    for (const curModel of candidateModels) {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(curModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: requestBody,
          signal: AbortSignal.timeout(12_000),
        });
        if (res.ok) {
          response = res;
          usedModel = curModel;
          break;
        }
        // If 404, try next candidate model
        if (res.status === 404) {
          console.warn(`[Gemini OCR] Model ${curModel} returned 404, trying next available model...`);
          continue;
        }
        response = res;
        break;
      } catch (e) {
        console.warn(`[Gemini OCR] Fetch error for ${curModel}:`, (e as Error).message);
      }
    }

    if (!response || !response.ok) {
      console.warn(`[Gemini OCR] Verification request failed (${response?.status ?? 'network error'})`);
      return currentFields;
    }

    const data = await response.json();
    const rawContent = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawContent) return currentFields;

    let parsed: { fields?: Record<string, { value?: string; confidence?: number }> } = {};
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      // Clean potential markdown blocks
      const cleanJson = rawContent.replace(/^```json\s*/, '').replace(/\s*```$/, '').trim();
      parsed = JSON.parse(cleanJson);
    }

    if (!parsed.fields) return currentFields;

    const merged: ReadResult = { ...currentFields };
    let verifiedCount = 0;

    for (const [key, verified] of Object.entries(parsed.fields)) {
      if (!verified?.value || typeof verified.value !== 'string') continue;
      const cleanVal = verified.value.trim();
      if (!cleanVal) continue;

      const current = merged[key];
      const prevConfidence = current?.confidence ?? 0;
      const newConfidence = Math.max(0.9, verified.confidence ?? 0.95);

      // Upgrade if field was missing, had low confidence, or Gemini found a cleaner value
      if (!current?.value || prevConfidence < 0.85 || prevConfidence <= newConfidence) {
        merged[key] = {
          value: cleanVal,
          confidence: newConfidence,
          reason: `Verified by ${usedModel}`,
          by: 'ai',
        };
        verifiedCount++;
      }
    }

    return merged;
  } catch (err) {
    console.warn('[Gemini OCR] Verification error (skipped):', (err as Error).message);
    return currentFields;
  }
}

/** Test if a Gemini API key is valid by sending a ping request with the selected model. */
export async function testGeminiApiKey(
  apiKey: string,
  modelId: GeminiModelId = geminiModel(),
): Promise<{ ok: boolean; error?: string; modelUsed?: string }> {
  if (!apiKey.trim()) return { ok: false, error: 'API key is empty' };

  const candidateModels: GeminiModelId[] = [
    modelId,
    ...GEMINI_MODELS.map((m) => m.id).filter((id) => id !== modelId),
  ];

  for (const curModel of candidateModels) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(curModel)}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Respond with JSON: {"status":"ok"}' }] }],
          generationConfig: {
            temperature: 0.1,
            response_mime_type: 'application/json',
          },
        }),
        signal: AbortSignal.timeout(6000),
      });

      if (response.ok) {
        return { ok: true, modelUsed: curModel };
      }

      if (response.status === 404) {
        continue;
      }

      const body = await response.json().catch(() => null);
      const errMsg = body?.error?.message || `HTTP ${response.status}`;
      return { ok: false, error: errMsg };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  return { ok: false, error: 'None of the specified Gemini models could be reached.' };
}
