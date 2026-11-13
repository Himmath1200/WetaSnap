import { backend } from './backend';
import { db, type LocalLead } from './db';
import { OfflineError, isOnline, net } from './net';
import { createStore } from './store';
import { refreshSession, session } from './session';
import { deviceLabel, nowIso } from './id';
import { reportError } from './errors';
import { emptyFilters, type Lead } from './types';

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
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'WETASNAP_TRIGGER_SYNC') void syncNow();
    });
  }
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

/** Requests the browser's Background Sync API if available. */
function requestBackgroundSync() {
  try {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'SyncManager' in window) {
      void navigator.serviceWorker.ready.then((reg: any) => {
        return reg.sync?.register('sync-leads');
      }).catch(() => {});
    }
  } catch {}
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

  // Immediately update monthly_scans in local session for solo accounts so header pill matches instantly
  const s = session.get();
  if (s && s.person.role === 'individual') {
    const activeCount = await db.leads
      .filter((l) => !l.deleted_at && l.captured_by === s.person.id)
      .count();
    const nextPerson = { ...s.person, monthly_scans: activeCount };
    const nextSession = { ...s, person: nextPerson };
    session.set(nextSession);
    void db.session.update('current', { person: nextPerson });
  }

  requestBackgroundSync();
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
    const me = session.get()?.person.id;
    const dirty = await db.leads.where('dirty').equals(1).toArray();
    for (const l of dirty.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
      const { dirty: _d, photo_pending: _p, photo_uploaded_at: _u, ...lead } = l;
      if (!lead.captured_by && me) lead.captured_by = me;
      try {
        const server = await b.syncLead(lead);
        await db.leads.update(l.id, { dirty: 0, status: server.status, synced_at: server.synced_at, crm_error: null, fields: mergeFields(l, server) });
      } catch (err) {
        if (err instanceof OfflineError) {
          // If network or server dropped, keep in dirty queue for retry and stop sync run
          throw err;
        }
        // One refused lead must not hold back the others. It stays on the phone with the reason shown
        // and is tried again on the next sync.
        await db.leads.update(l.id, { crm_error: (err as Error).message });
        void reportError(err, { action: 'Send a lead', where: 'sync › syncLead' });
      }
    }
    // 2. Then photos
    const photos = await db.leads.where('photo_pending').equals(1).toArray();
    for (const l of photos) {
      if (l.dirty) continue; // text must land first
      const leadPhotos = await db.photos.where('lead_id').equals(l.id).toArray();
      if (leadPhotos.length === 0) {
        await db.leads.update(l.id, { photo_pending: 0, photo_uploaded_at: nowIso() });
        continue;
      }
      let allOk = true;
      for (const p of leadPhotos) {
        try {
          await b.uploadPhoto(l.id, p.side, p.blob);
        } catch (err) {
          allOk = false;
          if (err instanceof OfflineError) throw err;
        }
      }
      if (allOk) {
        await db.leads.update(l.id, { photo_pending: 0, photo_uploaded_at: nowIso(), has_photo: true });
      }
    }
    // 3. Pull latest leads from server into local DB so all devices stay in sync (SYNC-02)
    try {
      const serverLeads = await b.listLeads({
        ...emptyFilters(),
        captured_by: me ? [me] : [],
      });
      if (serverLeads && serverLeads.length) {
        const local = new Set((await db.leads.toCollection().primaryKeys()) as string[]);
        const toAdd: LocalLead[] = [];
        for (const sl of serverLeads) {
          if (!local.has(sl.id)) {
            toAdd.push({ ...sl, dirty: 0, photo_pending: 0, photo_uploaded_at: null });
          } else {
            const cur = await db.leads.get(sl.id);
            if (cur && !cur.dirty) {
              await db.leads.update(sl.id, {
                status: sl.status, crm_error: sl.crm_error, crm_record_id: sl.crm_record_id,
                crm_history: sl.crm_history, fields: mergeFields(cur, sl), deleted_at: sl.deleted_at,
              });
            }
          }
        }
        if (toAdd.length > 0) {
          await db.leads.bulkPut(toAdd);
        }
      }
    } catch { /* transient or offline */ }
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
