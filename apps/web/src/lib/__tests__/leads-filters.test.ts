import { describe, expect, it } from 'vitest';
import { activeFilterCount, applyFilters, leadName } from '../leads';
import { emptyFilters, type Lead } from '../types';

const lead = (o: Partial<Lead> & { first?: string }): Lead => ({
  id: crypto.randomUUID(), company_id: 'c', event_id: 'e1', captured_by: 'p1', captured_by_name: 'Anna', device: 'x', source: 'camera',
  fields: { first_name: { value: o.first ?? 'Lukas', by: 'ai' }, last_name: { value: 'Test', by: 'ai' } },
  interest: null, notes: '', consent: true, consent_version: 1, consent_at: null, status: 'in_crm', crm_error: null, crm_record_id: null,
  crm_history: [], has_photo: false, has_back_photo: false, tag_ids: [], created_at: '2026-09-19T10:00:00.000Z', updated_at: '', synced_at: null, deleted_at: null, ...o,
});

const rows = [
  lead({ first: 'A', event_id: 'e1', captured_by: 'p1', tag_ids: ['t1'], created_at: '2026-09-22T09:00:00.000Z' }),
  lead({ first: 'B', event_id: 'e2', captured_by: 'p2', tag_ids: ['t2'], created_at: '2026-09-21T09:00:00.000Z' }),
  lead({ first: 'C', event_id: 'e3', captured_by: 'p3', tag_ids: ['t1', 't2'], created_at: '2026-09-20T09:00:00.000Z' }),
  lead({ first: 'D', event_id: 'e1', captured_by: 'p2', tag_ids: [], created_at: '2026-09-19T09:00:00.000Z' }),
];
const names = (l: Lead[]) => l.map(leadName).map((n) => n[0]);

describe('applyFilters — multi-select (LEAD-06)', () => {
  it('events: any of the chosen', () => {
    expect(names(applyFilters(rows, { ...emptyFilters(), event_ids: ['e1', 'e3'] }))).toEqual(['A', 'C', 'D']);
  });
  it('captured by: any of the chosen', () => {
    expect(names(applyFilters(rows, { ...emptyFilters(), captured_by: ['p2', 'p3'] }))).toEqual(['B', 'C', 'D']);
  });
  it('tags: a lead with any chosen tag matches; untagged leads never do', () => {
    expect(names(applyFilters(rows, { ...emptyFilters(), tag_ids: ['t1'] }))).toEqual(['A', 'C']);
    expect(names(applyFilters(rows, { ...emptyFilters(), tag_ids: ['t1', 't2'] }))).toEqual(['A', 'B', 'C']);
  });
  it('filters combine with AND across groups', () => {
    expect(names(applyFilters(rows, { ...emptyFilters(), event_ids: ['e1', 'e2'], captured_by: ['p2'], tag_ids: ['t2'] }))).toEqual(['B']);
  });
  it('sorts newest first regardless of input order', () => {
    expect(names(applyFilters([...rows].reverse(), emptyFilters()))).toEqual(['A', 'B', 'C', 'D']);
  });
  it('tolerates leads saved before tags existed (tag_ids missing)', () => {
    const old = { ...lead({ first: 'Z' }), tag_ids: undefined as unknown as string[] };
    expect(applyFilters([old], { ...emptyFilters(), tag_ids: ['t1'] })).toHaveLength(0);
    expect(applyFilters([old], emptyFilters())).toHaveLength(1);
  });
  it('the filter badge counts each chosen item', () => {
    expect(activeFilterCount({ ...emptyFilters(), event_ids: ['e1', 'e2'], captured_by: ['p1'], tag_ids: ['t1', 't2', 't3'] })).toBe(6);
  });
});
