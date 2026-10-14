import { describe, expect, it } from 'vitest';
import { holdsSeat, licenceStatus } from '../licence';

const now = new Date('2026-09-19T12:00:00');
describe('licenceStatus (LIC-03/04)', () => {
  it('active / trial far from the end', () => {
    expect(licenceStatus({ type: 'annual', ends_on: '2027-06-01' }, now)).toBe('active');
    expect(licenceStatus({ type: 'trial', ends_on: '2026-12-01' }, now)).toBe('trial');
  });
  it('expires soon within 30 days', () => expect(licenceStatus({ type: 'annual', ends_on: '2026-10-10' }, now)).toBe('expires_soon'));
  it('7-day grace, then read-only', () => {
    expect(licenceStatus({ type: 'annual', ends_on: '2026-09-15' }, now)).toBe('grace');
    expect(licenceStatus({ type: 'annual', ends_on: '2026-09-10' }, now)).toBe('read_only');
  });
});

describe('holdsSeat (ADM-02, W5)', () => {
  it('expired or deactivated people free their seat', () => {
    expect(holdsSeat({ active: true, access_ends_on: null, role: 'staff' }, now)).toBe(true);
    expect(holdsSeat({ active: true, access_ends_on: '2026-09-18', role: 'staff' }, now)).toBe(false);
    expect(holdsSeat({ active: true, access_ends_on: '2026-09-19', role: 'staff' }, now)).toBe(true);
    expect(holdsSeat({ active: false, access_ends_on: null, role: 'staff' }, now)).toBe(false);
  });
});
