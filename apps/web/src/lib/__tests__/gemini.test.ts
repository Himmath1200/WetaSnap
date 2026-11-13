import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  GEMINI_MODELS,
  geminiApiKey,
  geminiModel,
  hasLowConfidenceField,
  setGeminiApiKey,
  setGeminiModel,
  verifyLowConfidenceWithGemini,
} from '../gemini';
import type { ReadResult } from '../backend';
import type { FieldDefinition } from '../types';

const store = new Map<string, string>();
const mockStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
};

describe('Gemini OCR verification', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', mockStorage);
    mockStorage.clear();
    setGeminiApiKey('');
    vi.restoreAllMocks();
  });

  it('stores and retrieves Gemini API key and model', () => {
    expect(geminiApiKey()).toBe('');
    setGeminiApiKey('test-key-123');
    expect(geminiApiKey()).toBe('test-key-123');
    setGeminiApiKey('');
    expect(geminiApiKey()).toBe('');

    expect(geminiModel()).toBe('gemini-3.5-flash-lite');
    setGeminiModel('gemini-3-flash');
    expect(geminiModel()).toBe('gemini-3-flash');
  });

  it('includes all user requested Gemini models', () => {
    const ids = GEMINI_MODELS.map((m) => m.id);
    expect(ids).toContain('gemini-3.5-flash-lite');
    expect(ids).toContain('gemini-3.1-flash-lite');
    expect(ids).toContain('gemini-3.6-flash');
    expect(ids).toContain('gemini-3-flash');
    expect(ids).toContain('gemini-3.8-flash');
  });

  it('identifies low confidence fields correctly', () => {
    // High confidence with all critical fields
    const good: ReadResult = {
      first_name: { value: 'Alice', confidence: 0.95 },
      company: { value: 'Acme', confidence: 0.92 },
      email: { value: 'alice@acme.com', confidence: 0.99 },
    };
    expect(hasLowConfidenceField(good, 0.8)).toBe(false);

    // One low confidence field
    const lowConf: ReadResult = {
      first_name: { value: 'Alice', confidence: 0.95 },
      company: { value: 'Acme', confidence: 0.65 },
      email: { value: 'alice@acme.com', confidence: 0.99 },
    };
    expect(hasLowConfidenceField(lowConf, 0.8)).toBe(true);

    // Missing contact info
    const missingContact: ReadResult = {
      first_name: { value: 'Alice', confidence: 0.95 },
      company: { value: 'Acme', confidence: 0.90 },
    };
    expect(hasLowConfidenceField(missingContact, 0.8)).toBe(true);
  });

  it('skips verification if not available', async () => {
    setGeminiApiKey('');
    const fields: ReadResult = {
      first_name: { value: 'Bob', confidence: 0.5 },
    };
    const defs: FieldDefinition[] = [];
    const res = await verifyLowConfidenceWithGemini(null, fields, defs);
    expect(res).toEqual(fields);
  });

  it('merges verified fields from Gemini response using configured model', async () => {
    setGeminiApiKey('fake-key');
    setGeminiModel('gemini-3-flash');

    const fields: ReadResult = {
      first_name: { value: 'Rob', confidence: 0.6 },
      email: { value: 'rob@test.co', confidence: 0.7 },
    };

    const defs: FieldDefinition[] = [
      { key: 'first_name', label: 'First Name', type: 'text', options: [], required: true, ai_hint: '', filled_by: 'ai', sort_order: 1, id: '1', company_id: '1', template_id: '1' },
      { key: 'email', label: 'Email', type: 'email', options: [], required: true, ai_hint: '', filled_by: 'ai', sort_order: 2, id: '2', company_id: '1', template_id: '1' },
      { key: 'company', label: 'Company', type: 'text', options: [], required: false, ai_hint: '', filled_by: 'ai', sort_order: 3, id: '3', company_id: '1', template_id: '1' },
    ];

    // Mock fetch for Gemini API
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    fields: {
                      first_name: { value: 'Robert', confidence: 0.97 },
                      company: { value: 'Tech Innovations', confidence: 0.95 },
                      email: { value: 'robert@techinnovations.com', confidence: 0.98 },
                    },
                  }),
                },
              ],
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const verified = await verifyLowConfidenceWithGemini(null, fields, defs, 'Robert Tech Innovations robert@techinnovations.com');

    expect(mockFetch.mock.calls[0][0]).toContain('gemini-3-flash');
    expect(verified.first_name?.value).toBe('Robert');
    expect(verified.first_name?.confidence).toBeGreaterThanOrEqual(0.9);
    expect(verified.first_name?.reason).toBe('Verified by gemini-3-flash');
    expect(verified.company?.value).toBe('Tech Innovations');
    expect(verified.email?.value).toBe('robert@techinnovations.com');
  });
});
