import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { Building2, Camera, ScanLine, ScanSearch, ChevronDown, CloudOff, CreditCard, Download, Gauge, Globe, LifeBuoy, List, LogOut, Monitor, Moon, RefreshCw, ScrollText, Settings, ShieldCheck, Sun, UserCircle2, Users, Wifi, WifiOff } from 'lucide-preact';
import { doorForRole, linkFor, readPath, signInPath } from '../lib/portal';
import { useStore, toast } from '../lib/store';
import { config, endSession, session, setEvent } from '../lib/session';
import { syncNow, syncState } from '../lib/sync';
import { isOnline, net } from '../lib/net';
import { unsyncedCount } from '../lib/db';
import { daysLeft, licenceStatus } from '../lib/licence';
import { backend, isDemo, type SeatInfo } from '../lib/backend';
import { offlinePackReady, preloadOfflinePack } from '../lib/offlineReader';
import { t, tn } from '../lib/i18n';
import { Avatar, Copyright, Dialog, Sheet, Spinner } from './ui';

import { NotificationBell } from './NotificationBell';
import { applyTheme, theme, type ThemePref } from '../lib/theme';
import { startNotifications, stopNotifications } from '../lib/notifications';
import { startIdleWatch, stopIdleWatch } from '../lib/idle';
import type { Role } from '../lib/types';

interface NavItem { href: string; label: string; icon: typeof Camera }

const NAV: Record<Role, NavItem[]> = {
  staff: [
    { href: '/scan', label: 'Scan', icon: Camera },
    { href: '/scan-v2', label: 'Pro scan', icon: ScanSearch },
    { href: '/my-leads', label: 'My leads', icon: List },
  ],
  client_admin: [
    { href: '/leads', label: 'Leads', icon: List },
    { href: '/scan', label: 'Scan', icon: Camera },
    { href: '/scan-v2', label: 'Pro scan', icon: ScanSearch },
    { href: '/team', label: 'Team', icon: Users },
    { href: '/settings', label: 'Settings', icon: Settings },
    { href: '/my-leads', label: 'My leads', icon: ScanLine },
    { href: '/support', label: 'Support', icon: LifeBuoy },
  ],
  super_admin: [
    { href: '/companies', label: 'Companies', icon: Building2 },
    { href: '/subscriptions', label: 'Subscriptions', icon: CreditCard },
    { href: '/usage', label: 'Usage', icon: Gauge },
    { href: '/audit', label: 'Audit log', icon: ScrollText },
    { href: '/security', label: 'Security', icon: ShieldCheck },
    { href: '/support', label: 'Support', icon: LifeBuoy },
  ],
};

export function Logo({ small }: { small?: boolean }) {
  return (
    <span class="inline-flex items-center gap-2">
      <img src="/logo.png" alt="" width="36" height="36" class={small ? "size-7" : "size-9"} />
      <span class={`wordmark ${small ? 'text-[17px]' : 'text-[22px]'}`}>
        <span class="brand-text">WeTa</span> <span class="text-ink">Snap</span>
      </span>
    </span>
  );
}

export function ConnectionPill() {
  const n = useStore(net);
  const s = useStore(syncState);
  const online = n.online && !n.simulatedOffline;
  const label = !online
    ? `${t('Offline')}${s.waiting ? ` · ${t('{n} waiting', { n: s.waiting })}` : ''}`
    : s.waiting ? `${t('Online')} · ${t('{n} waiting', { n: s.waiting })}` : t('Online · all synced');
  const cls = !online ? 'bg-amber-100 text-amber-800' : s.waiting ? 'bg-ocean-100 text-ocean-800' : 'bg-brand-100 text-brand-800';
  const Icon = !online ? WifiOff : s.waiting ? RefreshCw : Wifi;
  return (
    <span class={`pill ${cls}`} title={label} aria-label={label} role="status">
      <Icon class={`size-3.5 ${s.running && online ? 'animate-spin' : ''}`} />
      {/* Full text from 400 px up; below that just the count (or nothing when all is synced). */}
      <span class="hidden min-[400px]:inline">{label}</span>
      {s.waiting > 0 && <span class="min-[400px]:hidden tabular-nums">{s.waiting}</span>}
    </span>
  );
}

export function AppShell({ children }: { children: ComponentChildren }) {
  const s = useStore(session)!;
  const cfg = useStore(config);
  const { path, route } = useLocation();
  const [menu, setMenu] = useState(false);
  const role = s.person.role;
  // Console links carry the /super-admin prefix; company links do not.
  const nav = NAV[role].map((n) => ({ ...n, href: linkFor(role, n.href) }));
  const event = cfg.events.find((e) => e.id === s.event_id);
  const isScan = readPath(path).here === '/scan' || readPath(path).here === '/scan-v2';
  // Phones get the first four; the rest live in the menu sheet.
  const barNav = nav.slice(0, 4);

  useEffect(() => {
    startNotifications();
    startIdleWatch();
    return () => { stopNotifications(); stopIdleWatch(); };
  }, [s.person.id]);

  return (
    <div class="flex min-h-dvh">
      {/* Laptop sidebar (admins) */}
      {role !== 'staff' && (
        <aside class="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-surface md:flex">
          <div class="accent-bar" />
          <div class="px-5 py-5"><Logo /></div>
          <nav class="flex-1 space-y-1 px-3">
            {nav.map((n) => (
              <a key={n.href} href={n.href} class={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition ${path.startsWith(n.href) ? 'bg-brand-50 text-brand-800' : 'text-slate-600 hover:bg-subtle hover:text-ink'}`}>
                <n.icon class={`size-5 ${path.startsWith(n.href) ? 'text-brand-700' : 'text-slate-400'}`} />{t(n.label)}
              </a>
            ))}
          </nav>
          <button class="m-3 flex items-center gap-3 rounded-xl p-2 text-left hover:bg-subtle" onClick={() => setMenu(true)}>
            <Avatar name={s.person.name} src={s.person.avatar_url} />
            <span class="min-w-0">
              <span class="block truncate text-sm font-semibold">{s.person.name}</span>
              <span class="block truncate text-xs text-muted">{s.company?.name ?? 'WeTano'}</span>
            </span>
          </button>
        </aside>
      )}

      <div class={`flex min-w-0 flex-1 flex-col ${isScan ? 'h-dvh' : ''}`}>
        <header class="sticky top-0 z-30 bg-surface pt-[env(safe-area-inset-top)]">
          <div class={`accent-bar ${role !== 'staff' ? 'md:hidden' : ''}`} />
          <div class="flex items-center gap-3 border-b border-line px-4 py-2.5 md:px-6">
            <span class={role !== 'staff' ? 'md:hidden' : ''}><Logo small /></span>
            {role !== 'super_admin' && (
              <button class="hidden min-h-11 min-w-0 items-center gap-1 rounded-lg px-2 py-1 text-sm font-semibold text-slate-700 hover:bg-slate-100 sm:flex" onClick={() => setMenu(true)} title={t('Change event')}>
                <span class="truncate">{event?.name ?? t('No event selected')}</span><ChevronDown class="size-4 shrink-0 text-slate-400" />
              </button>
            )}
            {role === 'staff' && (
              <nav class="ml-4 hidden gap-1 rounded-full border border-line bg-surface p-1 md:flex">
                {nav.map((n) => (
                  <a key={n.href} href={n.href} class={`flex min-h-11 items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold ${path.startsWith(n.href) ? 'on-brand' : 'text-slate-600 hover:bg-slate-100'}`}>
                    <n.icon class="size-4" />{t(n.label)}
                  </a>
                ))}
              </nav>
            )}
            <div class="ml-auto flex items-center gap-1.5">
              {role !== 'super_admin' && <ConnectionPill />}
              <NotificationBell />
              <button class={`flex size-11 items-center justify-center rounded-full ${role !== 'staff' ? 'md:hidden' : ''}`} onClick={() => setMenu(true)} aria-label={t('Menu')}><Avatar name={s.person.name} src={s.person.avatar_url} size="size-8" /></button>
            </div>
          </div>
          {role !== 'super_admin' && (
            <button class="flex min-h-11 w-full items-center gap-1 border-b border-line bg-brand-50/60 px-4 py-1.5 text-left text-xs font-semibold text-brand-900 sm:hidden" onClick={() => setMenu(true)}>
              <span class="truncate">{event ? `${event.name} · ${event.booth}` : t('No event selected')}</span><ChevronDown class="size-3.5 shrink-0" />
            </button>
          )}
          {role === 'client_admin' && <LicenceBanner />}
        </header>

        <main class={isScan ? 'flex min-h-0 flex-1 flex-col pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0' : 'flex-1 px-4 py-4 pb-24 md:px-6 md:py-6'}>
          {children}
          {/* Small print on every screen; the scanner keeps its full-height camera instead. */}
          {!isScan && <Copyright />}
        </main>

        {/* Phone bottom bar */}
        {barNav.length > 1 && (
          <nav class="fixed inset-x-0 bottom-0 z-20 grid border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden" style={{ gridTemplateColumns: `repeat(${barNav.length}, 1fr)` }}>
            {barNav.map((n) => {
              const on = path.startsWith(n.href);
              return (
                <a key={n.href} href={n.href} class={`flex flex-col items-center gap-0.5 py-2 text-[11px] font-semibold ${on ? 'text-brand-700' : 'text-slate-500'}`}>
                  <span class={`flex h-7 w-12 items-center justify-center rounded-full ${on ? 'bg-brand-100' : ''}`}><n.icon class="size-5" /></span>
                  {t(n.label)}
                </a>
              );
            })}
          </nav>
        )}
      </div>

      <MenuSheet open={menu} onClose={() => setMenu(false)} onSignedOut={() => route(signInPath(doorForRole(role)))} />
    </div>
  );
}

function LicenceBanner() {
  const [info, setInfo] = useState<SeatInfo | null>(null);
  useEffect(() => { backend().then((b) => b.seats()).then(setInfo).catch(() => {}); }, []);
  if (!info) return null;
  const st = licenceStatus(info.licence);
  if (st === 'active' || st === 'trial') return null;
  const d = daysLeft(info.licence.ends_on);
  const text = st === 'expires_soon' ? t('Your licence ends in {n} days. Contact WeTano to renew.', { n: d })
    : st === 'grace' ? t('Your licence has ended. You have {n} days of grace before the account becomes read-only.', { n: 7 + d })
    : t('Your licence has ended. Leads are still captured and stored, but not sent to the CRM until renewal.');
  return <div class={`px-4 py-2 text-xs font-semibold md:px-6 ${st === 'read_only' ? 'bg-slate-800 text-white' : 'bg-amber-100 text-amber-900'}`}>{text}</div>;
}

function MenuSheet({ open, onClose, onSignedOut }: { open: boolean; onClose: () => void; onSignedOut: () => void }) {
  const s = useStore(session)!;
  const cfg = useStore(config);
  const sync = useStore(syncState);
  const n = useStore(net);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [pack, setPack] = useState<'idle' | 'loading' | 'ready'>(offlinePackReady() ? 'ready' : 'idle');

  /** Staff capture into open events; an admin may also go back over a closed one (EVT-04). */
  const pickableEvents = cfg.events
    .filter((e) => e.status === 'open' || s.person.role === 'client_admin')
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'open' ? -1 : 1));

  /** Always asks first; when leads are still on the device it offers to sync them (AUTH-07). */
  async function signOut() {
    setConfirm(await unsyncedCount());
  }
  async function doSignOut() {
    await endSession();
    setConfirm(null);
    onClose();
    onSignedOut();
  }

  return (
    <>
      <Sheet open={open} onClose={onClose} title={<span class="flex items-center gap-3"><Avatar name={s.person.name} src={s.person.avatar_url} size="size-8" /><span class="min-w-0"><span class="block truncate">{s.person.name}</span><span class="block truncate text-xs font-normal text-muted">{s.person.email}</span></span></span>}>
        <div class="space-y-5">
          {s.person.role !== 'super_admin' && (
            <section>
              <p class="label">{t('Current event')}</p>
              <div class="space-y-1.5">
                {pickableEvents.map((e) => (
                  <button key={e.id} onClick={() => { onClose(); void setEvent(e.id); toast(t('Event changed to {name}', { name: e.name }), 'success'); }}
                    class={`flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left text-sm ${e.id === s.event_id ? 'border-brand-600 bg-brand-50' : 'border-line hover:bg-subtle'}`}>
                    <span class="min-w-0"><span class="block truncate font-semibold">{e.name}</span><span class="truncate text-xs text-muted">{e.venue} · {e.booth}</span></span>
                    {e.id === s.event_id
                      ? <span class="pill on-brand shrink-0">{t('Current')}</span>
                      : e.status !== 'open' && <span class="pill shrink-0 bg-subtle text-muted">{t(e.status)}</span>}
                  </button>
                ))}
                {pickableEvents.length === 0 && <p class="text-sm text-muted">{t('No open events yet. An admin can add one in Settings.')}</p>}
              </div>
            </section>
          )}

          {s.person.role !== 'super_admin' && (
            <section class="space-y-2">
              <button class="btn-secondary w-full justify-between" disabled={!isOnline() || sync.running} onClick={() => void syncNow().then(() => toast(t('Sync complete'), 'success'))}>
                <span class="flex items-center gap-2"><RefreshCw class={`size-4 ${sync.running ? 'animate-spin' : ''}`} />{t('Sync now')}</span>
                <span class="pill bg-ocean-100 text-ocean-800">{t('{n} waiting', { n: sync.waiting })}</span>
              </button>
              {s.company?.offline_pack_enabled && (
                <button class="btn-secondary w-full justify-between" disabled={pack !== 'idle' || !isOnline()}
                  onClick={async () => { setPack('loading'); try { await preloadOfflinePack(s.company?.default_language ?? 'en'); setPack('ready'); toast(t('Offline reading pack ready'), 'success'); } catch { setPack('idle'); toast(t('Download failed. Try again on Wi-Fi.'), 'error'); } }}>
                  <span class="flex items-center gap-2"><Download class="size-4" />{t('Offline reading pack')}</span>
                  <span class="text-xs">{pack === 'ready' ? t('Ready') : pack === 'loading' ? <Spinner class="size-4" /> : t('Download (≈ 8 MB)')}</span>
                </button>
              )}
            </section>
          )}

          <section>
            <a href={linkFor(s.person.role, '/profile')} onClick={onClose} class="flex min-h-11 items-center gap-2 rounded-xl border border-line px-3 py-2.5 text-sm font-semibold">
              <UserCircle2 class="size-4 text-ocean-700" />{t('My profile')}
            </a>
          </section>

          <section>
            <span class="label">{t('Appearance')}</span>
            <ThemePicker />
          </section>

          <section>
            <label class="label" for="lang"><Globe class="mr-1 inline size-3.5" />{t('Language')}</label>
            <select id="lang" class="input" disabled><option>English</option></select>
            <p class="mt-1 text-xs text-muted">{t('German and French are coming soon.')}</p>
          </section>

          {isDemo && s.person.role !== 'super_admin' && (
            <section class="rounded-xl border border-dashed border-ocean-500/40 bg-ocean-50 p-3">
              <label class="flex items-center justify-between gap-3 text-sm font-semibold text-ocean-800">
                <span class="flex items-center gap-2"><CloudOff class="size-4" />{t('Simulate offline (demo)')}</span>
                <input type="checkbox" class="size-5 accent-ocean-600" checked={n.simulatedOffline} onChange={(e) => net.set((x) => ({ ...x, simulatedOffline: e.currentTarget.checked }))} />
              </label>
            </section>
          )}

          {NAV[s.person.role].length > 4 && (
            <section class="md:hidden">
              <span class="label">{t('Other pages')}</span>
              <div class="grid grid-cols-2 gap-2">
                {NAV[s.person.role].slice(4).map((n) => (
                  <a key={n.href} href={linkFor(s.person.role, n.href)} onClick={onClose} class="flex items-center gap-2 rounded-xl border border-line px-3 py-2.5 text-sm font-semibold">
                    <n.icon class="size-4 text-ocean-700" />{t(n.label)}
                  </a>
                ))}
              </div>
            </section>
          )}

          <button class="btn-danger w-full" onClick={() => void signOut()}><LogOut class="size-4" />{t('Sign out')}</button>
        </div>
      </Sheet>

      <Dialog open={confirm !== null} onClose={() => setConfirm(null)} title={confirm ? t('Leads not sent yet') : t('Sign out?')}
        footer={<>
          <button class="btn-ghost" onClick={() => setConfirm(null)}>{t('No, stay signed in')}</button>
          {confirm
            ? <button class="btn-primary" disabled={!isOnline()} onClick={async () => { await syncNow(); const w = await unsyncedCount(); if (w === 0) await doSignOut(); else setConfirm(w); }}>{t('Sync first')}</button>
            : <button class="btn bg-red-600 text-white hover:bg-red-700" onClick={() => void doSignOut()}>{t('Yes, sign out')}</button>}
        </>}>
        {confirm
          ? <>
              <p class="text-sm text-slate-700">{tn(confirm, '{n} lead is still only on this device. Signing out deletes it. Sync first so nothing is lost.', '{n} leads are still only on this device. Signing out deletes them. Sync first so nothing is lost.')}</p>
              <button class="mt-3 text-xs font-semibold text-red-700 hover:underline" onClick={() => void doSignOut()}>{t('Sign out anyway and delete them')}</button>
            </>
          : <p class="text-sm text-slate-700">{t('You will need to sign in again. Leads already sent stay safe; anything else on this device is removed.')}</p>}
      </Dialog>
    </>
  );
}

/** Light · Dark · System (the phone or laptop setting). */
function ThemePicker() {
  const cur = useStore(theme);
  const items: { id: ThemePref; label: string; icon: typeof Sun }[] = [
    { id: 'light', label: 'Light', icon: Sun },
    { id: 'dark', label: 'Dark', icon: Moon },
    { id: 'system', label: 'System', icon: Monitor },
  ];
  return (
    <div class="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t('Appearance')}>
      {items.map((i) => (
        <button
          key={i.id} role="radio" aria-checked={cur === i.id} onClick={() => applyTheme(i.id)}
          class={`flex flex-col items-center gap-1 rounded-xl border px-2 py-2.5 text-xs font-semibold transition ${cur === i.id ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line text-slate-600 hover:bg-subtle'}`}
        >
          <i.icon class="size-4" />{t(i.label)}
        </button>
      ))}
    </div>
  );
}
