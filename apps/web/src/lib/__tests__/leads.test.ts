import { describe, expect, it } from 'vitest';
import { activeFilterCount, applyFilters, leadName, leadsToCsv } from '../leads';
import { emptyFilters, type Lead } from '../types';

const lead = (o: Partial<Lead> & { name?: string; email?: string }): Lead => ({
  id: crypto.randomUUID(), company_id: 'c', event_id: 'e1', captured_by: 'p1', captured_by_name: 'Anna', device: 'x', source: 'camera',
  fields: { first_name: { value: o.name ?? 'Lukas', by: 'ai' }, last_name: { value: 'Schneider', by: 'ai' }, email: { value: o.email ?? 'l@f.de', by: 'ai' } },
  interest: 'hot', notes: '', consent: true, consent_version: 1, consent_at: null, status: 'in_crm', crm_error: null, crm_record_id: null,
  crm_history: [], has_photo: false, has_back_photo: false, tag_ids: [], created_at: '2026-09-19T10:00:00.000Z', updated_at: '', synced_at: null, deleted_at: null, ...o,
});

describe('applyFilters (LEAD-06)', () => {
  const rows = [
    lead({ name: 'Lukas', event_id: 'e1', status: 'in_crm', interest: 'hot', created_at: '2026-09-19T10:00:00.000Z' }),
    lead({ name: 'Camille', event_id: 'e2', status: 'check', interest: 'cold', captured_by: 'p2', created_at: '2026-09-17T10:00:00.000Z' }),
    lead({ name: 'Marco', event_id: 'e1', status: 'waiting', interest: 'warm', deleted_at: '2026-09-19T11:00:00.000Z' }),
  ];
  it('hides soft-deleted leads', () => expect(applyFilters(rows, emptyFilters())).toHaveLength(2));
  it('filters by event, staff, status and interest', () => {
    expect(applyFilters(rows, { ...emptyFilters(), event_ids: ['e2'] }).map(leadName)).toEqual(['Camille Schneider']);
    expect(applyFilters(rows, { ...emptyFilters(), captured_by: ['p2'] })).toHaveLength(1);
    expect(applyFilters(rows, { ...emptyFilters(), status: 'check' })).toHaveLength(1);
    expect(applyFilters(rows, { ...emptyFilters(), interest: 'hot' })).toHaveLength(1);
  });
  it('filters by date range inclusively', () => {
    expect(applyFilters(rows, { ...emptyFilters(), from: '2026-09-18' })).toHaveLength(1);
    expect(applyFilters(rows, { ...emptyFilters(), from: '2026-09-17', to: '2026-09-17' })).toHaveLength(1);
  });
  it('searches every word across fields', () => {
    expect(applyFilters(rows, { ...emptyFilters(), q: 'camille schneider' })).toHaveLength(1);
    expect(applyFilters(rows, { ...emptyFilters(), q: 'nobody' })).toHaveLength(0);
  });
  it('counts active filters for the badge (search excluded)', () => {
    expect(activeFilterCount({ ...emptyFilters(), q: 'x' })).toBe(0);
    expect(activeFilterCount({ ...emptyFilters(), status: 'check', from: '2026-01-01', to: '2026-02-01' })).toBe(2);
  });
});

describe('leadsToCsv (ADM-06)', () => {
  it('escapes values and adds a BOM for Excel', () => {
    const csv = leadsToCsv([lead({ notes: 'Needs "quote", fast' })], [{ key: 'first_name', label: 'First name' }], () => 'link');
    expect(csv.startsWith('\ufeffFirst name,')).toBe(true);
    expect(csv).toContain('"Needs ""quote"", fast"');
  });
});
