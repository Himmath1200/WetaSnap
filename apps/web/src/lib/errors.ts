import { backend, type ClientErrorReport } from './backend';

/**
 * Every failure in the app is written to the audit log (action “error.<name>”) with what the
 * person was doing, the error, its root cause and where it happened — so WeTano can see it
 * without anyone having to describe it.
 *
 * Three ways in:
 *  - uncaught errors and rejected promises (installErrorCapture, from main.tsx)
 *  - the screen error boundary (App.tsx)
 *  - every error toast the app shows (lib/store.ts), because a toast means an action failed
 */

let installed = false;
let reporting = false;

export function installErrorCapture() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => {
    // Resource load failures (an image, a script chunk) have no error object.
    const err = e.error ?? new Error(e.message || 'Resource failed to load');
    void reportError(err, { action: 'Using the app', where: e.filename ? `${short(e.filename)}:${e.lineno}` : 'window' });
  });
  window.addEventListener('unhandledrejection', (e) => {
    void reportError(e.reason, { action: 'Background task', where: 'unhandled promise' });
  });
}

export interface ErrorContext {
  /** What the person was doing, in plain words. */
  action: string;
  /** Screen and function, e.g. “Leads › exportLeads”. */
  where: string;
}

export async function reportError(err: unknown, ctx: ErrorContext) {
  if (reporting) return; // never recurse if reporting itself fails
  reporting = true;
  try {
    const e = toError(err);
    // Offline is expected at a trade fair — not an error worth recording.
    if (e.message === 'offline') return;
    const report: ClientErrorReport = {
      action: ctx.action,
      name: errorName(e),
      message: e.message.slice(0, 500),
      cause: rootCause(e).slice(0, 500),
      where: ctx.where || screenName(),
      route: typeof location !== 'undefined' ? location.pathname : '',
      stack: (e.stack ?? '').split('\n').slice(0, 12).join('\n'),
      at: new Date().toISOString(),
      device: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 160) : '',
      online: typeof navigator !== 'undefined' ? navigator.onLine : true,
    };
    if (import.meta.env.DEV) console.warn('[WeTa Snap] error recorded', report);
    await (await backend()).recordClientError(report);
  } catch {
    /* never let reporting break the app */
  } finally {
    reporting = false;
  }
}

/** Called for error toasts: the message is what the person saw, the screen is where. */
export function reportShownError(message: string) {
  void reportError(new UserFacingError(message), { action: `Action on ${screenName()}`, where: screenName() });
}

export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionFailed';
  }
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === 'string') return new Error(err);
  try { return new Error(JSON.stringify(err)); } catch { return new Error(String(err)); }
}

function errorName(e: Error) {
  const code = (e as { code?: string | number }).code;
  if (code && typeof code !== 'object') return `${e.name || 'Error'}.${code}`;
  return e.name || 'Error';
}

/** Walks `cause` chains and known shapes (fetch responses, API errors). */
export function rootCause(e: Error): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    const c = cur as { message?: string; details?: string; hint?: string; status?: number; statusText?: string; cause?: unknown };
    if (c.status) parts.push(`HTTP ${c.status}${c.statusText ? ` ${c.statusText}` : ''}`);
    if (c.details) parts.push(c.details);
    if (c.hint) parts.push(`hint: ${c.hint}`);
    if (i > 0 && c.message) parts.push(c.message);
    cur = c.cause;
  }
  if (!parts.length) {
    if (/Failed to fetch|NetworkError|Load failed/i.test(e.message)) return 'The network request did not reach the server (no connection, blocked, or the server is down).';
    if (/Loading chunk|dynamically imported module/i.test(e.message)) return 'A part of the app could not be downloaded — usually a new version was released while the app was open.';
    if (/QuotaExceeded/i.test(e.name + e.message)) return 'The device storage is full.';
    if (e.name === 'ActionFailed') return 'The server or a rule refused the action (see the message).';
    if (e.name === 'TypeError') return 'A value the code expected was missing — a bug in the app.';
    return 'Unknown';
  }
  return parts.join(' · ');
}

function screenName() {
  if (typeof location === 'undefined') return 'app';
  const seg = location.pathname.split('/').filter(Boolean);
  return seg.length ? seg.map((x) => x.replace(/-/g, ' ')).join(' › ') : 'sign-in';
}

const short = (file: string) => file.split('/').slice(-2).join('/').split('?')[0];
