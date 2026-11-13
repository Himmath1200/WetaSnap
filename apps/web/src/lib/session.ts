import { createStore, toast } from './store';
import { db, wipeDevice, wipeDeviceKeepUnsynced, type Session } from './db';
import { backend, type SignedIn } from './backend';
import { OfflineError } from './net';
import type { EventItem, FieldDefinition } from './types';

const THIRTY_DAYS = 30 * 86_400_000;
/** Overwritten from the security policy (device_session_days) once it is known. */
let deviceSessionMs = THIRTY_DAYS;

export const session = createStore<Session | null | undefined>(undefined); // undefined = loading
export const config = createStore<{ events: EventItem[]; fields: FieldDefinition[] }>({ events: [], fields: [] });

/**
 * Every tab of this browser shares one device session, so they must never disagree about who is
 * signed in: a second tab that signs somebody else in would otherwise leave the first tab showing
 * the previous person's leads. Tabs tell each other, and the others reload onto the new session.
 */
const CHANNEL = 'wetasnap-session';
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;

interface SessionNews { personId: string | null }

function announce(personId: string | null) {
  const news: SessionNews = { personId };
  try {
    channel?.postMessage(news);
    // Older browsers (and iOS home-screen apps) without BroadcastChannel: the storage event
    // reaches the other tabs just as well.
    localStorage.setItem(CHANNEL, `${personId ?? ''}:${Date.now()}`);
  } catch { /* private windows: the tabs simply stay as they are */ }
}

let following = false;

/** Another tab signed somebody in or out. */
function follow(personId: string | null) {
  if (following) return; // one reload is enough, whichever channel told us first
  const here = session.get();
  if (here === undefined) return; // still starting up: restoreSession will read the new one
  if ((here?.person.id ?? null) === personId) return; // same person: nothing to follow
  // A different person, or a sign-out. Reload so nothing of the last one is left on screen —
  // lists, filters and cached photos all belong to whoever was signed in. Somebody new starts at
  // their own home screen rather than wherever the last person happened to be.
  following = true;
  if (personId) location.replace('/');
  else location.reload();
}

if (channel) {
  channel.onmessage = (e: MessageEvent<SessionNews>) => follow(e.data?.personId ?? null);
} else if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === CHANNEL) follow((e.newValue ?? '').split(':')[0] || null);
  });
}

/** Restore the 30-day device session; works offline (AUTH-03). */
export async function restoreSession() {
  const s = await db.session.get('current');
  if (!s || new Date(s.expires_at).getTime() < Date.now()) {
    session.set(null);
    return;
  }
  (await backend()).setToken(s.token);
  session.set(s);
  await loadCachedConfig();
  void refreshSession();
}

export async function startSession(si: SignedIn) {
  const s: Session = {
    id: 'current', token: si.token, person: si.person, company: si.company,
    session_id: si.session_id ?? null,
    idle_timeout_minutes: 0, // filled in from the security policy below
    last_active_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + THIRTY_DAYS).toISOString(),
    event_id: si.person.default_event_id,
  };
  const b = await backend();
  b.setToken(si.token);
  try {
    const policy = await b.securityPolicy();
    deviceSessionMs = policy.device_session_days * 86_400_000;
    s.idle_timeout_minutes = policy.idle_timeout_minutes;
    s.expires_at = new Date(Date.now() + deviceSessionMs).toISOString();
  } catch { /* offline: the defaults stand */ }
  await db.session.put(s);
  session.set(s);
  announce(s.person.id);
  await pullConfig();
}

/** Silent renewal when online; ends the session if access was removed (AUTH-05/06). */
export async function refreshSession() {
  const s = session.get();
  if (!s) return;
  try {
    const fresh = await (await backend()).refresh();
    if (!fresh) {
      // Do NOT kick user out on a temporary refresh hiccup or network drop
      return;
    }
    const next: Session = {
      ...s, person: fresh.person, company: fresh.company, session_id: fresh.session_id ?? s.session_id,
      expires_at: new Date(Date.now() + deviceSessionMs).toISOString(),
    };
    await db.session.put(next);
    session.set(next);
    await pullConfig();
  } catch (e) {
    if (!(e instanceof OfflineError)) console.warn('refresh failed', e);
  }
}

/** Events and card fields reach devices at their next sync (§5.9). */
export async function pullConfig() {
  const s = session.get();
  if (!s || s.person.role === 'super_admin') return;
  try {
    const b = await backend();
    const [events, fields] = await Promise.all([b.events(), b.fields(s.event_id)]);
    await db.cache.bulkPut([{ key: 'events', value: events }, { key: 'fields', value: fields }]);
    config.set({ events, fields });
    if (!s.event_id || !events.some((e) => e.id === s.event_id)) {
      const open = events.find((e) => e.status === 'open');
      if (open) await setEvent(open.id);
    }
  } catch (e) {
    if (!(e instanceof OfflineError)) throw e;
  }
}

async function loadCachedConfig() {
  const [ev, fl] = await Promise.all([db.cache.get('events'), db.cache.get('fields')]);
  config.set({ events: (ev?.value ?? []) as EventItem[], fields: (fl?.value ?? []) as FieldDefinition[] });
}

export async function setEvent(event_id: string) {
  const s = session.get();
  if (!s) return;
  const next = { ...s, event_id };
  await db.session.put(next);
  session.set(next);
  // The event decides the card fields (its template) — D-10.
  try {
    const fields = await (await backend()).fields(event_id);
    await db.cache.put({ key: 'fields', value: fields });
    config.set((c) => ({ ...c, fields }));
  } catch { /* offline: keep the cached fields */ }
}

/** Sign-out wipes local data (AUTH-07). `forced` = access removed by an admin. */
let ending = false;
export async function endSession(forced = false, opts: { keepUnsynced?: boolean } = {}) {
  if (ending) return;
  ending = true;
  try {
    try {
      await (await backend()).signOut();
    } catch { /* offline is fine */ }
    if (opts.keepUnsynced) await wipeDeviceKeepUnsynced();
    else await wipeDevice();
    session.set(null);
    config.set({ events: [], fields: [] });
    announce(null);
    if (forced) sessionStorage.setItem('wetasnap-ended', '1');
    // The sign-in page uses this to decide not to send the person back to the screen they left.
    sessionStorage.setItem('wetasnap-left', '1');
  } finally {
    ending = false;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('wetasnap:unauthorized', (e: Event) => {
    const detail = (e as CustomEvent<{ message?: string }>).detail;
    if (detail?.message) {
      toast(detail.message, 'error', 6000);
    }
    void endSession(true);
  });
}
