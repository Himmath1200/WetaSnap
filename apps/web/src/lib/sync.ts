import { backend } from './backend';
import { db, type LocalLead } from './db';
import { OfflineError, isOnline, net } from './net';
import { createStore } from './store';
import { refreshSession, session } from './session';
import { deviceLabel, nowIso } from './id';
import { reportError } from './errors';
import type { Lead } from './types';

/** Outbox sync (SYNC-01..06). Runs on reconnect, every 30 s while the app is open, and on "Sync now". */
export const syncState = createStore({ running: false, waiting: 0, lastSync: null as string | null, oldestWaiting: null as string | null });

const PHOTO_KEEP_MS = 24 * 3600_000; // SYNC-05
let timer: ReturnType<typeof setInterval> | undefined;
let inFlight: Promise<void> | null = null;

export function startSync() {
  if (timer) return;
  timer = setInterval(() => void syncNow(), 30_000);
  net.subscribe(() => { if (isOnline()) void syncNow(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void syncNow(); });
  void refreshCount();
  void syncNow();
}

export function stopSync() {
  clearInterval(timer);
  timer = undefined;
}

export async function refreshCount() {
  const pending = await db.leads.filter((l) => l.dirty === 1 || l.photo_pending === 1).toArray();
  const oldest = pending.map((l) => l.created_at).sort()[0] ?? null;
  syncState.set((s) => ({ ...s, waiting: pending.length, oldestWaiting: oldest }));
}

/** Save always writes to the device first (LEAD-02), then nudges the outbox. */
export async function saveLocal(lead: Lead, photo?: Blob | null, back?: Blob | null) {
  const local: LocalLead = { ...lead, status: 'waiting', dirty: 1, photo_pending: photo ? 1 : 0, photo_uploaded_at: null, updated_at: nowIso() };
  await db.transaction('rw', db.leads, db.photos, async () => {
    await db.leads.put(local);
    if (photo) await db.photos.put({ lead_id: lead.id, side: 'front', blob: photo });
    if (back) await db.photos.put({ lead_id: lead.id, side: 'back', blob: back });
  });
  await refreshCount();
  queueMicrotask(() => void syncNow());
}

/** Edit of an already-saved lead (S4 → S3 edit). Re-sent as an update, never a duplicate (CRM-06). */
export async function saveEdit(lead: Lead) {
  const cur = await db.leads.get(lead.id);
  await db.leads.put({ ...(cur ?? { photo_pending: 0, photo_uploaded_at: null }), ...lead, status: 'waiting', crm_error: null, dirty: 1, updated_at: nowIso() } as LocalLead);
  await refreshCount();
  queueMicrotask(() => void syncNow());
}

let again = false;

/** Runs the outbox now. A call during a running sync queues exactly one follow-up run, so nothing waits 30 s. */
export function syncNow(): Promise<void> {
  if (!isOnline() || !session.get()) return Promise.resolve();
  if (inFlight) {
    again = true;
    return inFlight;
  }
  inFlight = (async () => {
    do {
      again = false;
      await run();
    } while (again && isOnline());
  })().finally(() => { inFlight = null; });
  return inFlight;
}

async function run() {
  syncState.set((s) => ({ ...s, running: true }));
  try {
    const b = await backend();
    // 1. Text first (SYNC-04)
    // Only this person's leads: a colleague's leads kept on a shared phone wait for their owner (D-1).
    const me = session.get()?.person.id;
    const dirty = (await db.leads.where('dirty').equals(1).toArray()).filter((l) => l.captured_by === me);
    for (const l of dirty.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
      const { dirty: _d, photo_pending: _p, photo_uploaded_at: _u, ...lead } = l;
      try {
        const server = await b.syncLead(lead);
        await db.leads.update(l.id, { dirty: 0, status: server.status, synced_at: server.synced_at, crm_error: null, fields: mergeFields(l, server) });
      } catch (err) {
        if (err instanceof OfflineError) throw err;
        // One refused lead must not hold back the others. It stays on the phone with the reason shown
        // and is tried again on the next sync.
        await db.leads.update(l.id, { crm_error: (err as Error).message });
        void reportError(err, { action: 'Send a lead', where: 'sync › syncLead' });
      }
    }
    // 2. Then photos
    const photos = (await db.leads.where('photo_pending').equals(1).toArray()).filter((l) => l.captured_by === me);
    for (const l of photos) {
      if (l.dirty) continue; // text must land first
      for (const p of await db.photos.where('lead_id').equals(l.id).toArray()) await b.uploadPhoto(l.id, p.side, p.blob);
      await db.leads.update(l.id, { photo_pending: 0, photo_uploaded_at: nowIso(), has_photo: true });
    }
    // 3. Pull status changes back (Synced → In CRM / Check) and AI fills for offline captures
    const open = await db.leads.filter((l) => l.captured_by === me && l.dirty === 0 && l.status !== 'in_crm').toArray();
    const recent = await db.leads.filter((l) => l.dirty === 0 && Date.now() - new Date(l.updated_at).getTime() < 3600_000).toArray();
    const ids = [...new Set([...open, ...recent].map((l) => l.id))];
    if (ids.length) {
      for (const s of await b.leadsByIds(ids)) {
        const cur = await db.leads.get(s.id);
        if (!cur || cur.dirty) continue;
        await db.leads.update(s.id, {
          status: s.status, crm_error: s.crm_error, crm_record_id: s.crm_record_id, crm_history: s.crm_history,
          fields: mergeFields(cur, s), deleted_at: s.deleted_at,
        });
      }
    }
    // 4. Free space: photos 24 h after confirmed upload (SYNC-05). Unsynced data is never deleted.
    const old = await db.leads.filter((l) => !!l.photo_uploaded_at && Date.now() - new Date(l.photo_uploaded_at).getTime() > PHOTO_KEEP_MS).toArray();
    for (const l of old) await db.photos.where('lead_id').equals(l.id).delete();

    await refreshCount();
    const st = syncState.get();
    await b.reportOutbox(deviceLabel(), st.waiting, st.oldestWaiting).catch(() => {});
    syncState.set((s) => ({ ...s, lastSync: nowIso() }));
    await refreshSession(); // after the outbox is flushed (W5)
  } catch (e) {
    if (!(e instanceof OfflineError)) console.warn('sync failed; will retry', e);
  } finally {
    await refreshCount();
    syncState.set((s) => ({ ...s, running: false }));
  }
}

/** Server values win for fields a person did not type on this device (AI-04). */
function mergeFields(local: Lead, server: Lead): Lead['fields'] {
  const out = { ...server.fields };
  for (const [k, v] of Object.entries(local.fields)) if (v.by === 'person' || !out[k]?.value) out[k] = v;
  return out;
}
