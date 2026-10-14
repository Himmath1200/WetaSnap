import { backend } from './backend';
import { createStore } from './store';
import { session } from './session';
import { isOnline } from './net';
import type { AppNotification } from './types';

/** In-app notification feed + optional push. Reminders are notifications with a `remind_at`. */
export const notifications = createStore<AppNotification[]>([]);
export const pushState = createStore<'unsupported' | 'default' | 'granted' | 'denied'>('unsupported');

let timer: ReturnType<typeof setInterval> | undefined;

export const unreadCount = (list: AppNotification[]) => list.filter((n) => !n.read_at).length;

/** Reminders that are due now (shown at the top of the panel). */
export const dueReminders = (list: AppNotification[]) =>
  list.filter((n) => n.remind_at && new Date(n.remind_at).getTime() <= Date.now() && !n.read_at);

export async function refreshNotifications() {
  if (!session.get() || !isOnline()) return;
  try {
    notifications.set(await (await backend()).notifications());
  } catch { /* offline or no access */ }
}

export function startNotifications() {
  if (timer) return;
  void refreshNotifications();
  timer = setInterval(() => void refreshNotifications(), 60_000);
  pushState.set(supportsPush() ? (Notification.permission as 'default' | 'granted' | 'denied') : 'unsupported');
}

export function stopNotifications() {
  clearInterval(timer);
  timer = undefined;
  notifications.set([]);
}

export async function markRead(ids: string[]) {
  if (!ids.length) return;
  const at = new Date().toISOString();
  notifications.set((l) => l.map((n) => (ids.includes(n.id) ? { ...n, read_at: n.read_at ?? at } : n)));
  try {
    await (await backend()).markNotificationsRead(ids);
  } catch { /* will re-sync on the next poll */ }
}

// ---------------------------------------------------------------- push
export const supportsPush = () =>
  typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;

/** Ask for permission and register this device for push (iPhone: only from a home-screen app). */
export async function enablePush(vapidKey: string) {
  if (!supportsPush()) throw new Error('This browser cannot show notifications when the app is closed.');
  const permission = await Notification.requestPermission();
  pushState.set(permission as 'granted' | 'denied' | 'default');
  if (permission !== 'granted') throw new Error('Notifications are blocked. Allow them in your browser settings.');
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidKey) }));
  await (await backend()).savePushSubscription(sub.toJSON());
}

export async function disablePush() {
  if (!supportsPush()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await (await backend()).savePushSubscription(null).catch(() => {});
    await sub.unsubscribe();
  }
  pushState.set(Notification.permission as 'default' | 'granted' | 'denied');
}

function urlBase64ToUint8Array(base64: string) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
