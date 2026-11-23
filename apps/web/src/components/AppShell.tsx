import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { AlertCircle, Building2, Calendar, Camera, ScanLine, ChevronDown, ChevronRight, CloudOff, CreditCard, Crown, Download, Gauge, Globe, HelpCircle, Home, LifeBuoy, List, LogOut, MapPin, Monitor, Moon, Plus, RefreshCw, ScrollText, Settings, ShieldCheck, Sparkles, Store, Sun, UserCircle2, Users, Wifi, WifiOff } from 'lucide-preact';
import { doorForRole, linkFor, readPath, signInPath } from '../lib/portal';
import { useStore, toast } from '../lib/store';
import { config, endSession, session, setEvent } from '../lib/session';
import { syncNow, syncState } from '../lib/sync';
import { isOnline, net } from '../lib/net';
import { db, unsyncedCount } from '../lib/db';
import { useLive } from '../lib/useLive';
import { daysLeft, licenceStatus } from '../lib/licence';
import { backend, isDemo, type SeatInfo } from '../lib/backend';
import { offlinePackReady, preloadOfflinePack } from '../lib/offlineReader';
import { t, tn } from '../lib/i18n';
import { Avatar, Copyright, Dialog, Sheet, Spinner } from './ui';
import { NotificationBell } from './NotificationBell';
import { applyTheme, theme, type ThemePref } from '../lib/theme';
import { startNotifications, stopNotifications } from '../lib/notifications';
import { startIdleWatch, stopIdleWatch } from '../lib/idle';
import { OnboardingTour } from './OnboardingTour';
import type { Role } from '../lib/types';

interface NavItem { href: string; label: string; icon: typeof Camera }

const NAV: Record<Role, NavItem[]> = {
  staff: [
    { href: '/home', label: 'Home', icon: Home },
    { href: '/scan-v2', label: 'Scans', icon: Camera },
    { href: '/leads', label: 'All leads', icon: List },
  ],
  organizer: [
    { href: '/home', label: 'Home', icon: Home },
    { href: '/leads', label: 'All leads', icon: List },
    { href: '/scan-v2', label: 'Scan', icon: Camera },
    { href: '/team', label: 'Event Team', icon: Users },
    { href: '/my-leads', label: 'My leads', icon: ScanLine },
    { href: '/support', label: 'Support', icon: LifeBuoy },
  ],
  individual: [
    { href: '/home', label: 'Home', icon: Home },
    { href: '/leads', label: 'All leads', icon: List },
    { href: '/scan-v2', label: 'Scan', icon: Camera },
    { href: '/upgrade', label: 'Pro plan', icon: Sparkles },
    { href: '/support', label: 'Support', icon: LifeBuoy },
  ],
  client_admin: [
    { href: '/home', label: 'Home', icon: Home },
    { href: '/leads', label: 'All leads', icon: List },
    { href: '/scan-v2', label: 'Scan', icon: Camera },
    { href: '/my-leads', label: 'My leads', icon: ScanLine },
    { href: '/team', label: 'Team', icon: Users },
    { href: '/settings', label: 'Settings', icon: Settings },
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
    <span class="inline-flex items-center gap-2 shrink-0">
      <img src="/logo.png" alt="" width="36" height="36" class={small ? 'size-7' : 'size-9'} />
      <span class={`wordmark shrink-0 ${small ? 'text-[17px]' : 'text-[22px]'}`}>
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
    <button
      type="button"
      onClick={() => {
        if (online) {
          toast(t('Syncing leads with server...'), 'info', 2000);
          void syncNow();
        } else {
          toast(t('Offline mode: {n} leads stored locally. Reconnect to sync.', { n: s.waiting }), 'info', 3000);
        }
      }}
      class={`pill shrink-0 ${cls} cursor-pointer transition-opacity hover:opacity-85`}
      title={online ? (s.waiting ? t('Tap to sync now') : t('All leads synced')) : t('Offline mode')}
      aria-label={label}
      role="status"
    >
      <Icon class={`size-3.5 ${s.running && online ? 'animate-spin' : ''}`} />
      <span class="hidden min-[520px]:inline">{label}</span>
      {s.waiting > 0 && <span class="min-[520px]:hidden tabular-nums">{s.waiting}</span>}
    </button>
  );
}

function OfflineNoticeBanner() {
  const n = useStore(net);
  const s = useStore(syncState);
  const online = n.online && !n.simulatedOffline;
  const [offlineQueued, setOfflineQueued] = useState(false);

  useEffect(() => {
    if (!online && s.waiting > 0) {
      setOfflineQueued(true);
    } else if (online && s.waiting === 0) {
      setOfflineQueued(false);
    }
  }, [online, s.waiting]);

  // Case 1: Currently offline
  if (!online) {
    return (
      <div class="flex items-center justify-between gap-2 bg-amber-500 px-4 py-2 text-xs font-semibold text-white">
        <div class="flex items-center gap-2 min-w-0">
          <WifiOff class="size-4 shrink-0" />
          <span class="truncate">{t('Offline Mode — Leads are stored safely in IndexedDB on this device.')}</span>
        </div>
        {s.waiting > 0 && (
          <span class="shrink-0 rounded-full bg-white/20 px-2 py-0.5 text-[10px] tabular-nums">
            {t('{n} cards queued', { n: s.waiting })}
          </span>
        )}
      </div>
    );
  }

  // Case 2: Was offline, now reconnected and syncing those offline-queued leads
  if (offlineQueued && s.waiting > 0) {
    return (
      <div class="flex items-center justify-between gap-2 bg-ocean-600 px-4 py-2 text-xs font-semibold text-white">
        <div class="flex items-center gap-2 min-w-0">
          <RefreshCw class={`size-4 shrink-0 ${s.running ? 'animate-spin' : ''}`} />
          <span class="truncate">
            {s.running
              ? t('Internet reconnected — syncing {n} offline cards to database...', { n: s.waiting })
              : t('Internet reconnected — {n} offline cards ready to sync.', { n: s.waiting })}
          </span>
        </div>
        <button
          type="button"
          disabled={s.running}
          onClick={() => void syncNow()}
          class="shrink-0 rounded-lg bg-white/20 px-2.5 py-1 text-[11px] font-bold hover:bg-white/30 transition disabled:opacity-50"
        >
          {s.running ? t('Syncing...') : t('Sync Now')}
        </button>
      </div>
    );
  }

  return null;
}

export function AppShell({ children }: { children: ComponentChildren }) {
  const s = useStore(session)!;
  const cfg = useStore(config);
  const { path, route } = useLocation();
  const [menu, setMenu] = useState(false);
  const [eventSheet, setEventSheet] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const role = s.person.role;
  const nav = NAV[role].map((n) => ({ ...n, href: linkFor(role, n.href) }));
  const event = cfg.events.find((e) => e.id === s.event_id);
  const isScan = readPath(path).here === '/scan' || readPath(path).here === '/scan-v2';
  const barNav = (role === 'individual' || role === 'client_admin') ? nav.slice(0, 5) : nav.slice(0, 4);

  const individualScanCount = role === 'individual'
    ? (useLive<number>(
        () => db.leads.filter((l) => !l.deleted_at && l.captured_by === s.person.id).count(),
        [s.person.id],
        s.person.monthly_scans ?? 0,
      ) ?? (s.person.monthly_scans ?? 0))
    : (s.person.monthly_scans ?? 0);

  useEffect(() => {
    startNotifications();
    startIdleWatch();
    return () => { stopNotifications(); stopIdleWatch(); };
  }, [s.person.id]);

  return (
    <div class="flex min-h-dvh">
      {/* Desktop sidebar — admins, organizers & individuals */}
      {role !== 'staff' && (
        <aside class="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-line bg-surface md:flex">
          <div class="px-5 py-5 flex items-center justify-between border-b border-line">
            <Logo />
            <span class="pill text-[10px] bg-brand-50 text-brand-700 font-bold uppercase tracking-wider">
              {role === 'client_admin' ? t('Admin') : role === 'organizer' ? t('Organizer') : role === 'individual' ? (s.person.plan === 'pro' ? t('Pro') : t('Solo')) : t('Super Admin')}
            </span>
          </div>

          <div class="px-3 pt-3 pb-1">
            <p class="px-2 text-[11px] font-bold uppercase tracking-wider text-muted mb-1.5">{t('Navigation')}</p>
          </div>

          <nav class="flex-1 space-y-1 px-3 overflow-y-auto">
            {nav.map((n) => {
              const active = path.startsWith(n.href);
              return (
                <a
                  key={n.href}
                  href={n.href}
                  class={`relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition ${
                    active
                      ? 'bg-brand-50 text-brand-700 font-bold shadow-sm'
                      : 'text-muted hover:bg-subtle hover:text-ink'
                  }`}
                >
                  {active && (
                    <span class="absolute left-0 top-2 bottom-2 w-1 rounded-r-full bg-brand-600" />
                  )}
                  <n.icon class={`size-5 shrink-0 ${active ? 'text-brand-600' : 'text-slate-400'}`} />
                  <span class="truncate">{t(n.label)}</span>
                </a>
              );
            })}
          </nav>

          {/* Event selector in sidebar — visible for company admins & organizers on desktop */}
          {role !== 'super_admin' && role !== 'individual' && (
            <div class="px-3 pb-2 pt-1">
              <p class="px-1 text-[11px] font-bold uppercase tracking-wider text-muted mb-1.5">{t('Live Event')}</p>
              <button
                class="flex w-full items-center gap-2.5 rounded-xl border border-line bg-subtle/50 px-3 py-2.5 text-left hover:bg-subtle hover:border-brand-300 transition"
                onClick={() => setEventSheet(true)}
              >
                <span class="w-8 h-8 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
                  <Store class="size-4 text-brand-700" />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-xs font-bold text-ink">{event?.name ?? t('No event selected')}</span>
                  {event?.booth
                    ? <span class="block text-[10px] text-muted truncate">Booth {event.booth}</span>
                    : <span class="block text-[10px] text-muted truncate">{t('Tap to switch')}</span>}
                </span>
                <ChevronRight class="size-3.5 text-muted shrink-0" />
              </button>
            </div>
          )}

          {/* User profile button at bottom */}
          <div class="p-3 bg-subtle/30">
            <button
              class="flex w-full items-center gap-3 rounded-xl p-2 text-left hover:bg-subtle transition-colors"
              onClick={() => setMenu(true)}
            >
              <Avatar name={s.person.name} src={s.person.avatar_url} />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-semibold text-ink">{s.person.name}</span>
                <span class="block truncate text-xs text-muted">{s.company?.name ?? (role === 'individual' ? (s.person.plan === 'pro' ? 'Pro Plan' : 'Free Plan') : role === 'organizer' ? 'Event Organizer' : 'WeTano')}</span>
              </span>
              <ChevronRight class="size-4 text-muted shrink-0" />
            </button>
          </div>
        </aside>
      )}

      <div class={`flex min-w-0 flex-1 flex-col ${isScan ? 'h-dvh' : ''}`}>
        <header class="sticky top-0 z-30 bg-surface pt-[env(safe-area-inset-top)]">
          <div class="flex items-center justify-between gap-2 border-b border-line px-3 py-2 sm:px-4 md:px-6">
            <span class={`shrink-0 ${role !== 'staff' ? 'md:hidden' : ''}`}><Logo small /></span>
            {role === 'staff' && (
              <div class="ml-4 hidden items-center gap-3 md:flex">
                <nav class="flex gap-1 rounded-full border border-line bg-subtle p-1">
                  {nav.map((n) => (
                    <a key={n.href} href={n.href} class={`flex min-h-11 items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold ${path.startsWith(n.href) ? 'on-brand' : 'text-muted hover:bg-surface hover:text-ink'}`}>
                      <n.icon class="size-4" />{t(n.label)}
                    </a>
                  ))}
                </nav>
                <button
                  class="flex items-center gap-2 rounded-full border border-line bg-subtle px-3.5 py-2 text-xs font-semibold text-ink hover:border-brand-400 hover:bg-surface transition-colors"
                  onClick={() => setEventSheet(true)}
                  title={t('Switch event')}
                >
                  <Store class="size-3.5 text-brand-600 shrink-0" />
                  <span class="max-w-44 truncate">{event?.name ?? t('No event selected')}</span>
                  <ChevronDown class="size-3 text-muted shrink-0" />
                </button>
              </div>
            )}
            <div class="ml-auto flex items-center gap-1.5 shrink-0">
              {role === 'individual' && (
                <a
                  href={linkFor(role, '/upgrade')}
                  class={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold shrink-0 transition-colors ${
                    s.person.plan === 'pro'
                      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30'
                      : individualScanCount >= 5
                      ? 'bg-red-500/15 text-red-600 border border-red-500/30'
                      : 'bg-subtle text-muted border border-line hover:text-ink'
                  }`}
                  title={s.person.plan === 'pro' ? t('Pro Plan: Unlimited Scans') : t('Click to Upgrade')}
                >
                  {s.person.plan === 'pro' ? (
                    <>
                      <Crown class="size-3 text-emerald-600" />
                      <span>{t('Pro')}</span>
                    </>
                  ) : (
                    <>
                      <Sparkles class="size-3 text-brand-600" />
                      <span>{individualScanCount}/5</span>
                    </>
                  )}
                </a>
              )}
              {role !== 'super_admin' && <ConnectionPill />}
              <button
                type="button"
                class="flex size-9 sm:size-10 items-center justify-center rounded-full border border-line bg-surface text-muted hover:text-brand-600 hover:border-brand-300 transition-colors shrink-0"
                onClick={() => setTourOpen(true)}
                title={t('App Guide & Feature Tour')}
                aria-label={t('App Guide')}
              >
                <HelpCircle class="size-4" />
              </button>
              <NotificationBell />
              <button class={`flex size-10 sm:size-11 items-center justify-center rounded-full shrink-0 ${role !== 'staff' ? 'md:hidden' : ''}`} onClick={() => setMenu(true)} aria-label={t('Menu')}>
                <Avatar name={s.person.name} src={s.person.avatar_url} size="size-8" />
              </button>
            </div>
          </div>
          {/* Clean dedicated event sub-bar on mobile — sits below the logo, full width (not shown for individuals) */}
          {role !== 'super_admin' && role !== 'individual' && (
            <button
              class="flex min-h-10 w-full items-center justify-between border-b border-line bg-subtle/60 px-4 py-2 text-left transition-colors hover:bg-subtle md:hidden"
              onClick={() => setEventSheet(true)}
              title={t('Event details')}
            >
              <div class="flex items-center gap-2 min-w-0">
                <Store class="size-3.5 text-brand-600 shrink-0" />
                <span class="truncate text-xs font-semibold text-ink">
                  {event?.name ?? t('No event selected')}
                </span>
                {event?.booth && (
                  <span class="text-[11px] text-muted truncate">· Booth {event.booth}</span>
                )}
              </div>
              <ChevronDown class="size-3.5 text-muted shrink-0 ml-2" />
            </button>
          )}
          {role === 'client_admin' && <LicenceBanner />}
          {(role === 'organizer' || s.person.organizer_id || s.person.event_ends_on) && <OrganizerDisclaimerBanner />}
          <OfflineNoticeBanner />
        </header>

        <main class={isScan ? 'flex min-h-0 flex-1 flex-col pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0' : 'flex-1 px-4 py-4 pb-24 md:px-6 md:py-6'}>
          {children}
          {!isScan && <Copyright />}
        </main>

        {/* Phone bottom nav */}
        {barNav.length > 1 && (
          <nav class="fixed inset-x-0 bottom-0 z-20 grid border-t border-line bg-surface/95 backdrop-blur pb-[env(safe-area-inset-bottom)] md:hidden" style={{ gridTemplateColumns: `repeat(${barNav.length}, 1fr)` }}>
            {barNav.map((n) => {
              const on = path.startsWith(n.href);
              return (
                <a key={n.href} href={n.href} class={`flex flex-col items-center gap-0.5 py-2 text-[11px] font-semibold transition-colors ${on ? 'text-brand-600' : 'text-muted hover:text-ink'}`}>
                  <span class={`flex h-7 w-12 items-center justify-center rounded-full transition-colors ${on ? 'bg-brand-100' : ''}`}><n.icon class="size-5" /></span>
                  {t(n.label)}
                </a>
              );
            })}
          </nav>
        )}
      </div>

      <EventSheet open={eventSheet} onClose={() => setEventSheet(false)} />
      <MenuSheet open={menu} onClose={() => setMenu(false)} onSignedOut={() => route(signInPath(doorForRole(role)))} onOpenTour={() => setTourOpen(true)} />
      <OnboardingTour role={s.person.role} isOpen={tourOpen} onClose={() => setTourOpen(false)} />
    </div>
  );
}

function getEventState(e: { starts_on: string; ends_on: string; status: 'open' | 'closed' }): 'ongoing' | 'upcoming' | 'completed' {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(e.starts_on); start.setHours(0, 0, 0, 0);
  const end = new Date(e.ends_on); end.setHours(23, 59, 59, 999);
  if (e.status === 'closed' || today > end) return 'completed';
  if (today < start) return 'upcoming';
  return 'ongoing';
}

function EventStatusTag({ state }: { state: 'ongoing' | 'upcoming' | 'completed' }) {
  if (state === 'ongoing') {
    return (
      <span class="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 shrink-0">
        <span class="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
        {t('Ongoing')}
      </span>
    );
  }
  if (state === 'upcoming') {
    return (
      <span class="inline-flex items-center gap-1 rounded-full border border-indigo-500/30 bg-indigo-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-indigo-700 dark:text-indigo-400 shrink-0">
        <span class="size-1.5 rounded-full bg-indigo-500" />
        {t('Upcoming')}
      </span>
    );
  }
  return (
    <span class="inline-flex items-center gap-1 rounded-full border border-line bg-subtle px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted shrink-0">
      {t('Completed')}
    </span>
  );
}

/** Full event details sheet + event picker for staff / link to manage for admins */
function EventSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useStore(session)!;
  const cfg = useStore(config);
  const role = s.person.role;
  const event = cfg.events.find((e) => e.id === s.event_id);

  // Show all events, sorted: ongoing first, upcoming second, completed last
  const STATE_ORDER = { ongoing: 0, upcoming: 1, completed: 2 };
  const pickableEvents = [...cfg.events].sort((a, b) => {
    const diff = STATE_ORDER[getEventState(a)] - STATE_ORDER[getEventState(b)];
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  });

  function pick(id: string) {
    void setEvent(id);
    toast(t('Event changed'), 'success');
    onClose();
  }

  return (
      <Sheet open={open} onClose={onClose} centered title={
      <span class="flex items-center gap-2">
        <span class="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center">
          <Store class="size-4 text-brand-700" />
        </span>
        <span>{t('Events')}</span>
      </span>
    }>
      <div class="space-y-5">
        {/* Active event details */}
        {event ? (
          <div class="rounded-2xl border border-line bg-subtle p-4 space-y-3">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <p class="font-bold text-ink text-base leading-tight truncate">{event.name}</p>
                <div class="mt-1 flex items-center gap-2">
                  <EventStatusTag state={getEventState(event)} />
                  {event.booth && <span class="text-xs text-muted">Booth {event.booth}</span>}
                </div>
              </div>
            </div>
            {event.venue && (
              <div class="flex items-center gap-2 text-sm text-muted">
                <MapPin class="size-4 shrink-0 text-brand-600" />
                <span>{event.venue}</span>
              </div>
            )}
            <div class="flex items-center gap-2 text-sm text-muted">
              <Calendar class="size-4 shrink-0 text-brand-600" />
              <span>
                {new Date(event.starts_on).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}
                {' – '}
                {new Date(event.ends_on).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}
              </span>
            </div>
            {event.description && (
              <p class="text-sm text-muted border-t border-line pt-3">{event.description}</p>
            )}
          </div>
        ) : (
          <div class="rounded-2xl border border-line bg-subtle p-6 text-center">
            <Store class="size-8 text-muted mx-auto mb-2" />
            <p class="text-sm font-semibold text-ink">{t('No event selected')}</p>
            <p class="text-xs text-muted mt-0.5">{t('Pick one below to get started.')}</p>
          </div>
        )}

        {/* Event picker — everyone can pick any event to view scans or scan if ongoing */}
        {pickableEvents.length > 0 && (
          <div>
            <p class="label mb-2">{t('Switch event')}</p>
            <div class="space-y-1.5">
              {pickableEvents.map((e) => {
                const state = getEventState(e);
                const isActive = e.id === s.event_id;
                return (
                  <button
                    key={e.id}
                    onClick={() => pick(e.id)}
                    class={`flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition ${
                      isActive
                        ? 'border-brand-500 bg-brand-50 dark:bg-brand-950/30'
                        : 'border-line hover:bg-subtle'
                    }`}
                  >
                    <span class={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${isActive ? 'bg-brand-100' : 'bg-subtle'}`}>
                      <Store class={`size-4 ${isActive ? 'text-brand-700' : 'text-muted'}`} />
                    </span>
                    <span class="flex-1 min-w-0">
                      <span class="flex items-center gap-2">
                        <span class="text-sm font-semibold text-ink truncate">{e.name}</span>
                        {isActive && <span class="pill on-brand shrink-0 text-[9px] py-0 px-1.5">{t('Active')}</span>}
                      </span>
                      <span class="block text-xs text-muted truncate">
                        {new Date(e.starts_on).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                        {' – '}
                        {new Date(e.ends_on).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                        {e.venue ? ` · ${e.venue}` : ''}
                      </span>
                    </span>
                    <EventStatusTag state={state} />
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Admin CTA to manage events */}
        {role === 'client_admin' && (
          <a
            href={linkFor(role, '/settings?tab=events')}
            onClick={onClose}
            class="flex items-center gap-3 rounded-xl border border-line px-4 py-3 text-sm font-semibold text-ink hover:bg-subtle transition-colors"
          >
            <span class="w-8 h-8 rounded-lg bg-subtle flex items-center justify-center">
              <Plus class="size-4 text-brand-700" />
            </span>
            <span class="flex-1">{t('Add or manage events')}</span>
            <ChevronRight class="size-4 text-muted" />
          </a>
        )}

        {pickableEvents.length === 0 && (
          <p class="text-sm text-muted text-center py-4">{t('No events available yet.')}</p>
        )}
      </div>
    </Sheet>
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
  return <div class={`px-4 py-2 text-xs font-semibold md:px-6 ${st === 'read_only' ? 'bg-ink text-surface' : 'bg-amber-100 text-amber-900'}`}>{text}</div>;
}

function OrganizerDisclaimerBanner() {
  const s = useStore(session)!;
  const cfg = useStore(config);
  const event = cfg.events.find((e) => e.id === s.event_id) ?? cfg.events[0];
  // If an attendee has an earlier custom access end date set by organizer, prioritize it
  const endsOn = (s.person.role === 'staff' && s.person.access_ends_on)
    ? s.person.access_ends_on
    : (s.person.event_ends_on ?? event?.ends_on);
  const endsDateStr = endsOn ? new Date(endsOn).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : null;
  const leadsLink = linkFor(s.person.role, '/leads');

  return (
    <div class="border-b border-amber-500/30 bg-amber-500/15 px-4 py-2.5 text-xs text-amber-950 dark:text-amber-200 md:px-6 flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <AlertCircle class="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span class="font-semibold">
          {t('Important Notice: Lead scans are temporary. Access concludes on {date}. You can export your leads until 24 hours after access ends, after which data will be permanently cleared.', {
            date: endsDateStr || t('the scheduled date'),
          })}
        </span>
      </div>
      <a href={leadsLink} class="underline font-bold text-amber-900 dark:text-amber-300 hover:opacity-80 shrink-0">
        {t('Export Leads Now')} →
      </a>
    </div>
  );
}

function MenuSheet({ open, onClose, onSignedOut, onOpenTour }: { open: boolean; onClose: () => void; onSignedOut: () => void; onOpenTour: () => void }) {
  const s = useStore(session)!;
  const sync = useStore(syncState);
  const n = useStore(net);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [pack, setPack] = useState<'idle' | 'loading' | 'ready'>(offlinePackReady() ? 'ready' : 'idle');

  async function signOut() { setConfirm(await unsyncedCount()); }
  async function doSignOut() {
    await endSession();
    setConfirm(null);
    onClose();
    onSignedOut();
  }

  return (
    <>
    <Sheet open={open} onClose={onClose} centered wide title={
        <span class="flex items-center gap-3">
          <Avatar name={s.person.name} src={s.person.avatar_url} size="size-8" />
          <span class="min-w-0">
            <span class="block truncate text-ink">{s.person.name}</span>
            <span class="block truncate text-xs font-normal text-muted">{s.person.email}</span>
          </span>
        </span>
      }>
        <div class="space-y-5">
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

          <section class="space-y-2">
            <button
              type="button"
              class="flex w-full min-h-11 items-center gap-2 rounded-xl border border-line px-3 py-2.5 text-sm font-semibold text-ink hover:bg-subtle transition-colors text-left"
              onClick={() => { onClose(); onOpenTour(); }}
            >
              <HelpCircle class="size-4 text-brand-600" />
              <span>{t('App Guide & Feature Tour')}</span>
            </button>
            <a href={linkFor(s.person.role, '/profile')} onClick={onClose} class="flex min-h-11 items-center gap-2 rounded-xl border border-line px-3 py-2.5 text-sm font-semibold text-ink hover:bg-subtle transition-colors">
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
                {NAV[s.person.role].slice(4).map((nav) => (
                  <a key={nav.href} href={linkFor(s.person.role, nav.href)} onClick={onClose} class="flex items-center gap-2 rounded-xl border border-line px-3 py-2.5 text-sm font-semibold text-ink hover:bg-subtle transition-colors">
                    <nav.icon class="size-4 text-ocean-700" />{t(nav.label)}
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
              <p class="text-sm text-muted">{tn(confirm, '{n} lead is still only on this device. Signing out deletes it. Sync first so nothing is lost.', '{n} leads are still only on this device. Signing out deletes them. Sync first so nothing is lost.')}</p>
              <button class="mt-3 text-xs font-semibold text-red-700 hover:underline" onClick={() => void doSignOut()}>{t('Sign out anyway and delete them')}</button>
            </>
          : <p class="text-sm text-muted">{t('You will need to sign in again. Leads already sent stay safe; anything else on this device is removed.')}</p>}
      </Dialog>
    </>
  );
}

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
        <button key={i.id} role="radio" aria-checked={cur === i.id} onClick={() => applyTheme(i.id)}
          class={`flex flex-col items-center gap-1 rounded-xl border px-2 py-2.5 text-xs font-semibold transition ${cur === i.id ? 'border-brand-600 bg-brand-100 text-brand-700' : 'border-line text-muted hover:bg-subtle hover:text-ink'}`}>
          <i.icon class="size-4" />{t(i.label)}
        </button>
      ))}
    </div>
  );
}
