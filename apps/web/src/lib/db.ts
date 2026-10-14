import Dexie, { type Table } from 'dexie';
import type { Company, EventItem, FieldDefinition, Lead, Person } from './types';

/** A lead as stored on this device, plus outbox bookkeeping (SYNC-01..04). */
export interface LocalLead extends Lead {
  /** true while the text part still has to reach the server */
  dirty: 0 | 1;
  /** true while the photo still has to be uploaded */
  photo_pending: 0 | 1;
  photo_uploaded_at: string | null;
}

export interface LocalPhoto {
  lead_id: string;
  side: 'front' | 'back';
  blob: Blob;
}

export interface Session {
  id: 'current';
  token: string;
  /** Row in the server's device list; used by “Active sessions”. */
  session_id: string | null;
  /** Signed out automatically after this much idle time (set by the security policy). */
  idle_timeout_minutes: number;
  last_active_at: string;
  person: Person;
  company: Company | null;
  expires_at: string; // 30 days, renewed silently (AUTH-03)
  event_id: string | null;
}

export interface Cache {
  key: 'events' | 'fields';
  value: EventItem[] | FieldDefinition[];
}

class DeviceDb extends Dexie {
  leads!: Table<LocalLead, string>;
  photos!: Table<LocalPhoto, [string, string]>;
  session!: Table<Session, string>;
  cache!: Table<Cache, string>;

  constructor() {
    super('wetasnap-device');
    this.version(1).stores({
      leads: 'id, event_id, captured_by, status, dirty, photo_pending, created_at',
      photos: '[lead_id+side], lead_id',
      session: 'id',
      cache: 'key',
    });
    // Tags and the back-of-card photo arrived later; devices already in use are filled in here.
    this.version(2).stores({
      leads: 'id, event_id, captured_by, status, dirty, photo_pending, created_at',
      photos: '[lead_id+side], lead_id',
      session: 'id',
      cache: 'key',
    }).upgrade((tx) =>
      tx.table('leads').toCollection().modify((l: Partial<LocalLead>) => {
        l.tag_ids ??= [];
        l.has_back_photo ??= false;
      }),
    );
  }
}

export const db = new DeviceDb();

export async function cached<T extends Cache['value']>(key: Cache['key']): Promise<T> {
  return ((await db.cache.get(key))?.value ?? []) as T;
}

/** Ask the browser not to evict our data (URS §8.2 Offline, §9.3). */
export async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* not supported */
  }
}

/** Wipes everything on this device (AUTH-07). Caller must check unsynced first. */
export async function wipeDevice() {
  await Promise.all([db.leads.clear(), db.photos.clear(), db.session.clear(), db.cache.clear()]);
}

/**
 * Signs the device out but keeps every lead that has not reached the server yet (and its photos).
 * Used when the app signs someone out by itself (idle timeout) — CLAUDE.md: never delete unsynced data.
 * The kept leads still carry their `captured_by`, and the sync engine only ever sends the signed-in
 * person's own leads, so they wait for their owner to sign in again.
 */
export async function wipeDeviceKeepUnsynced() {
  await db.transaction('rw', db.leads, db.photos, db.session, db.cache, async () => {
    const kept = await db.leads.filter((l) => l.dirty === 1 || l.photo_pending === 1).primaryKeys();
    const keep = new Set(kept as string[]);
    await db.leads.filter((l) => !keep.has(l.id)).delete();
    await db.photos.filter((p) => !keep.has(p.lead_id)).delete();
    await db.session.clear();
    await db.cache.clear();
  });
}

export async function unsyncedCount() {
  return db.leads.filter((l) => l.dirty === 1 || l.photo_pending === 1).count();
}
