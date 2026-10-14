import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, STRENGTH_LABEL, checkPassword, passwordExpired, passwordStrength } from '../password';

describe('password.ts (policy-driven rules)', () => {
  it('accepts the demo password under the default policy', () => {
    expect(checkPassword('WetaSnap#2026', DEFAULT_POLICY)).toEqual(['That is too easy to guess.']);
    expect(checkPassword('Harbour-lantern47', DEFAULT_POLICY)).toEqual([]);
  });

  it('lists every broken rule, worst first', () => {
    expect(checkPassword('short', DEFAULT_POLICY)).toEqual([
      'Use at least 12 characters.', 'Add a capital letter.', 'Add a number.', 'Add a symbol, for example ! or #.',
    ]);
    expect(checkPassword('Password1234!', DEFAULT_POLICY)).toEqual(['That is too easy to guess.']);
  });

  it('follows the policy switches', () => {
    const lax = { ...DEFAULT_POLICY, min_length: 6, require_upper: false, require_number: false, require_symbol: false };
    expect(checkPassword('abcdef', lax)).toEqual([]);
    expect(checkPassword('abcde', lax)).toEqual(['Use at least 6 characters.']);
    expect(checkPassword('abcdefgh', { ...lax, require_symbol: true })).toEqual(['Add a symbol, for example ! or #.']);
  });

  it('does not treat a space or underscore as a symbol', () => {
    expect(checkPassword('Abcdefghij12_', DEFAULT_POLICY)).toContain('Add a symbol, for example ! or #.');
    expect(checkPassword('Abcdefghij12 ', DEFAULT_POLICY)).toContain('Add a symbol, for example ! or #.');
  });

  it('strength is 0–4 with a label for each step', () => {
    expect(passwordStrength('')).toBe(0);
    expect(passwordStrength('abc')).toBe(0);
    expect(passwordStrength('abcdefghijkl')).toBe(1);
    expect(passwordStrength('Abcdefghijkl')).toBe(2);
    expect(passwordStrength('Abcdefghijk1!')).toBe(3);
    expect(passwordStrength('Abcdefghijklmno1!')).toBe(4);
    expect(STRENGTH_LABEL).toHaveLength(5);
  });

  it('expiry follows expiry_days; 0 means never', () => {
    const now = new Date('2026-09-22T00:00:00Z');
    expect(passwordExpired('2026-01-01T00:00:00Z', DEFAULT_POLICY, now)).toBe(true);
    expect(passwordExpired('2026-06-01T00:00:00Z', DEFAULT_POLICY, now)).toBe(false);
    expect(passwordExpired('2000-01-01T00:00:00Z', { ...DEFAULT_POLICY, expiry_days: 0 }, now)).toBe(false);
  });
});
