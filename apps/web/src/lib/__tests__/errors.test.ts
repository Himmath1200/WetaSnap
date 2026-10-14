import { describe, expect, it } from 'vitest';
import { UserFacingError, rootCause } from '../errors';

const withProps = (msg: string, props: Record<string, unknown>) => Object.assign(new Error(msg), props);

describe('errors.ts rootCause', () => {
  it('walks the cause chain and collects HTTP status, details and hints', () => {
    const inner = withProps('duplicate key value', { details: 'Key (email)=(x) already exists.', hint: 'use upsert' });
    const outer = withProps('Save failed', { status: 409, statusText: 'Conflict', cause: inner });
    expect(rootCause(outer)).toBe('HTTP 409 Conflict · Key (email)=(x) already exists. · hint: use upsert · duplicate key value');
  });

  it('stops after five levels even for a cyclic chain', () => {
    const a = withProps('a', { status: 500 });
    (a as { cause?: unknown }).cause = a;
    expect(rootCause(a).split(' · ').length).toBeLessThanOrEqual(10); // bounded, no infinite loop
  });

  it('explains common failures in plain words', () => {
    expect(rootCause(new TypeError('Failed to fetch'))).toMatch(/did not reach the server/);
    expect(rootCause(new Error('Failed to fetch dynamically imported module: /x.js'))).toMatch(/could not be downloaded|did not reach/);
    expect(rootCause(new Error('Loading chunk 7 failed'))).toMatch(/could not be downloaded/);
    expect(rootCause(Object.assign(new Error('quota'), { name: 'QuotaExceededError' }))).toBe('The device storage is full.');
    expect(rootCause(new UserFacingError('Please check: Email'))).toBe('The server or a rule refused the action (see the message).');
    expect(rootCause(new TypeError("Cannot read properties of undefined (reading 'value')"))).toBe('A value the code expected was missing — a bug in the app.');
    expect(rootCause(new Error('something odd'))).toBe('Unknown');
  });

  it('UserFacingError is named ActionFailed', () => {
    expect(new UserFacingError('x').name).toBe('ActionFailed');
  });
});
