import { backend } from './backend';
import { db, unsyncedCount } from './db';
import { syncNow } from './sync';
import { endSession, session } from './session';
import { toast } from './store';
import { t } from './i18n';

/**
 * Signs a person out after the idle time set by WeTano in the security policy.
 * Scanning staff are deliberately included — a booth phone left on a table is a risk —
 * but nothing unsynced is lost: the outbox is flushed first and a warning shows beforehand.
 */
const WARN_BEFORE_MS = 60_000;
let timer: ReturnType<typeof setInterval> | undefined;
let warned = false;

const ACTIVITY = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'visibilitychange'] as const;

export function startIdleWatch() {
  if (timer) return;
  ACTIVITY.forEach((e) => window.addEventListener(e, touch, { passive: true }));
  timer = setInterval(() => void check(), 15_000);
  void loadPolicy();
}

export function stopIdleWatch() {
  clearInterval(timer);
  timer = undefined;
  ACTIVITY.forEach((e) => window.removeEventListener(e, touch));
}

function touch() {
  warned = false;
  const s = session.get();
  if (!s) return;
  const now = new Date().toISOString();
  // Keep it cheap: only write every 30 s.
  if (Date.now() - new Date(s.last_active_at).getTime() < 30_000) return;
  session.set({ ...s, last_active_at: now });
  void db.session.update('current', { last_active_at: now });
}

/** The policy is set centrally, so devices pick up changes at their next sign-in or sync. */
export async function loadPolicy() {
  const s = session.get();
  if (!s) return;
  try {
    const p = await (await backend()).securityPolicy();
    if (p.idle_timeout_minutes !== s.idle_timeout_minutes) {
      session.set({ ...s, idle_timeout_minutes: p.idle_timeout_minutes });
      await db.session.update('current', { idle_timeout_minutes: p.idle_timeout_minutes });
    }
  } catch { /* offline: keep what the device already knows */ }
}

async function check() {
  const s = session.get();
  if (!s || !s.idle_timeout_minutes) return;
  const idleMs = Date.now() - new Date(s.last_active_at).getTime();
  const limitMs = s.idle_timeout_minutes * 60_000;
  if (idleMs > limitMs) {
    // D-1: try to send what is still on the phone first; whatever cannot be sent now is kept.
    await syncNow().catch(() => {});
    const waiting = await unsyncedCount();
    if (waiting > 0) sessionStorage.setItem('wetasnap-kept', String(waiting));
    await endSession(true, { keepUnsynced: waiting > 0 });
    return;
  }
  if (!warned && idleMs > limitMs - WARN_BEFORE_MS) {
    warned = true;
    toast(t('You will be signed out in a minute — touch the screen to stay signed in.'), 'info', 8000);
  }
}
