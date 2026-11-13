import { beforeAll, describe, expect, it } from 'vitest';
import { backend } from '../backend';
import { db } from '../db';
import { session } from '../session';
import { saveLocal, syncNow } from '../sync';
import { net } from '../net';
import type { Lead } from '../types';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function draft(o: Partial<Lead> = {}): Lead {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), company_id: 'c0000000-0000-4000-8000-000000000001', event_id: 'e0000000-0000-4000-8000-000000000001',
    captured_by: 'p-anna', captured_by_name: 'Anna Weber', device: 'test', source: 'manual',
    fields: { first_name: { value: 'Test', by: 'person' }, last_name: { value: 'Person', by: 'person' }, email: { value: 'test@example.com', by: 'person' } },
    interest: 'hot', notes: '', consent: true, consent_version: 1, consent_at: now, status: 'waiting', crm_error: null, crm_record_id: null,
    crm_history: [], has_photo: false, has_back_photo: false, tag_ids: [], created_at: now, updated_at: now, synced_at: null, deleted_at: null, ...o,
  };
}

describe('outbox sync against the demo backend (SYNC-01..04, LEAD-02)', () => {
  beforeAll(async () => {
    const b = await backend();
    b.setToken('p-anna');
    await b.refresh(); // seeds the demo server
    session.set({ id: 'current', token: 'p-anna', session_id: null, idle_timeout_minutes: 0, last_active_at: new Date().toISOString(), person: { id: 'p-anna', company_id: 'c0000000-0000-4000-8000-000000000001', email: 'anna@agroexpo.de', name: 'Anna Weber', phone: '', role: 'staff', event_ids: [], default_event_id: null, avatar_url: null, access_ends_on: null, active: true, invited: false }, company: null, expires_at: '2099-01-01', event_id: null });
  });

  it('keeps leads on the device while offline, then sends them once', async () => {
    net.set((s) => ({ ...s, simulatedOffline: true }));
    const l = draft();
    await saveLocal(l);
    await syncNow();
    expect((await db.leads.get(l.id))?.dirty).toBe(1);

    net.set((s) => ({ ...s, simulatedOffline: false }));
    await syncNow();
    await syncNow(); // a retry must not duplicate (SYNC-03)
    const local = await db.leads.get(l.id);
    expect(local?.dirty).toBe(0);
    expect(local?.status).not.toBe('waiting');
    const server = await (await backend()).leadsByIds([l.id]);
    expect(server).toHaveLength(1);
  });

  it('pulls CRM status back and flags data errors for a fix (W4)', async () => {
    const bad = draft({ fields: { first_name: { value: 'Bad', by: 'person' }, last_name: { value: 'Mail', by: 'person' }, email: { value: 'bad at mail', by: 'person' } } });
    const good = draft();
    await saveLocal(bad);
    await saveLocal(good);
    await syncNow();
    await wait(3500); // demo pipeline: AI step + CRM push
    await syncNow();
    expect((await db.leads.get(bad.id))?.status).toBe('check');
    expect((await db.leads.get(bad.id))?.crm_error).toMatch(/email/i);
    expect((await db.leads.get(good.id))?.status).toBe('in_crm');
  }, 10_000);
});
