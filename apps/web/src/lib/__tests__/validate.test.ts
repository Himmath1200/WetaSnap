import { describe, expect, it } from 'vitest';
import { fieldError, normalisePhone, normaliseUrl } from '../validate';

describe('validation (AI-08)', () => {
  it('normalises phones to international format', async () => {
    expect(await normalisePhone('0151 23456789', 'DE')).toBe('+49 1512 3456789');
    expect(await normalisePhone('+33 6 12 34 56 78')).toBe('+33 6 12 34 56 78');
    expect(await normalisePhone('12')).toBeNull();
  });
  it('normalises websites', () => {
    expect(normaliseUrl('feldtechnik.de')).toBe('https://feldtechnik.de');
    expect(normaliseUrl('not a site')).toBeNull();
  });
  it('reports required and invalid values', () => {
    expect(fieldError('text', '', true)).toBeTruthy();
    expect(fieldError('email', 'a at b', false)).toBeTruthy();
    expect(fieldError('email', 'a@b.de', true)).toBeNull();
  });
});
