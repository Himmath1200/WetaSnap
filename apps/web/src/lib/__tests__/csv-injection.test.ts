import { describe, expect, it } from 'vitest';
import { leadsToCsv } from '../leads';
import type { Lead } from '../types';

const lead = (company: string): Lead => ({
  id: 'l1', company_id: 'c', event_id: 'e', captured_by: 'p', captured_by_name: 'Anna', device: 'x', source: 'camera',
  fields: { company: { value: company, by: 'ai' } }, interest: null, notes: '', consent: false, consent_version: 1, consent_at: null,
  status: 'in_crm', crm_error: null, crm_record_id: null, crm_history: [], has_photo: false, has_back_photo: false, tag_ids: [],
  created_at: '2026-09-22T10:00:00.000Z', updated_at: '', synced_at: null, deleted_at: null,
});

/** Card text is untrusted: a value starting with = + - @ must not become a spreadsheet formula (OWASP CSV injection). */
describe.skipIf(!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.QA_DEFECTS)('KNOWN DEFECT — CSV export neutralises formulas (run with QA_DEFECTS=1)', () => {
  for (const evil of ['=HYPERLINK("http://evil","x")', '+SUM(1,2)', '-2+3', '@cmd']) {
    it(`escapes ${evil.slice(0, 12)}…`, () => {
      const csv = leadsToCsv([lead(evil)], [{ key: 'company', label: 'Company' }], () => '');
      const cell = csv.split('\r\n')[1]!.split(',')[0]!.replace(/^"/, '');
      expect(/^[=+\-@]/.test(cell)).toBe(false);
    });
  }
});

describe('leadsToCsv keeps ordinary values intact', () => {
  it('leaves normal text alone', () => {
    const csv = leadsToCsv([lead('Feldtechnik GmbH')], [{ key: 'company', label: 'Company' }], () => '');
    expect(csv.split('\r\n')[1]!.startsWith('Feldtechnik GmbH,')).toBe(true);
  });
});
