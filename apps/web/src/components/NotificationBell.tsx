import { useEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import {
  AlarmClock, Bell, BellOff, BellRing, CalendarDays, CheckCheck, ChevronRight, CloudOff, CreditCard, LifeBuoy,
  Settings2, TriangleAlert, Upload, UserPlus,
} from 'lucide-preact';
import { useStore, toast } from '../lib/store';
import {
  disablePush, dueReminders, enablePush, markRead, notifications, pushState, refreshNotifications, supportsPush,
  unreadCount,
} from '../lib/notifications';
import { timeAgo } from '../lib/id';

import { SCREENS } from '../routes';
import { linkFor } from '../lib/portal';
import { session } from '../lib/session';
import { t } from '../lib/i18n';
import type { AppNotification, NotificationKind } from '../lib/types';

const ICON: Record<NotificationKind, typeof Bell> = {
  lead_failed: TriangleAlert,
  leads_waiting: CloudOff,
  licence_expiring: AlarmClock,
  licence_expired: AlarmClock,
  event_starting: CalendarDays,
  person_invited: UserPlus,
  import_done: Upload,
  support_reply: LifeBuoy,
  subscription: CreditCard,
};

const TONE: Partial<Record<NotificationKind, string>> = {
  lead_failed: 'bg-red-50 text-red-700',
  leads_waiting: 'bg-amber-50 text-amber-800',
  licence_expiring: 'bg-amber-50 text-amber-800',
  licence_expired: 'bg-red-50 text-red-700',
};

type Tab = 'all' | 'unread' | 'reminders';

/**
 * Bell in the header. On a laptop it opens a quiet dropdown anchored under the bell;
 * on a phone the same panel slides up from the bottom. Tabs keep it short, and every
 * row navigates to the screen it is about.
 */
export function NotificationBell() {
  const list = useStore(notifications);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const unread = unreadCount(list);

  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', click);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', click); document.removeEventListener('keydown', key); };
  }, [open]);

  return (
    <div class="relative" ref={wrap}>
      <button
        class={`relative flex size-11 items-center justify-center rounded-full transition ${open ? 'bg-ocean-50 text-ocean-700' : 'text-slate-600 hover:bg-subtle hover:text-ink'}`}
        onClick={() => { setOpen((o) => !o); void refreshNotifications(); }}
        aria-expanded={open} aria-haspopup="dialog"
        aria-label={unread ? t('Notifications ({n} unread)', { n: unread }) : t('Notifications')}
      >
        {unread > 0 ? <BellRing class="size-5" /> : <Bell class="size-5" />}
        {unread > 0 && (
          <span class="absolute top-0.5 right-0.5 flex min-w-4.5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white tabular-nums">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && <div class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm sm:hidden" onClick={() => setOpen(false)} />}
      {open && <Panel onClose={() => setOpen(false)} />}
    </div>
  );
}

function Panel({ onClose }: { onClose: () => void }) {
  const role = useStore(session)!.person.role;
  const list = useStore(notifications);
  const push = useStore(pushState);
  const { route } = useLocation();
  const [tab, setTab] = useState<Tab>('all');
  const unread = unreadCount(list);
  const reminders = dueReminders(list);
  const upcoming = list.filter((n) => n.remind_at && new Date(n.remind_at).getTime() > Date.now());

  const shown =
    tab === 'unread' ? list.filter((n) => !n.read_at)
    : tab === 'reminders' ? [...reminders, ...upcoming]
    : list;


  const go = (link: string) => {

    const inner = link.split('?')[0]!;
    // A link to a screen this role cannot open is ignored rather than bouncing home (D-17).
    if (!SCREENS[role].includes(inner)) return;
    route(linkFor(role, link));
  };

  function openItem(n: AppNotification) {
    void markRead([n.id]);
    if (n.link) { onClose(); go(n.link); }
  }

  async function togglePush() {
    try {
      if (push === 'granted') { await disablePush(); toast(t('Alerts turned off on this device'), 'info'); }
      else { await enablePush(import.meta.env.VITE_VAPID_PUBLIC_KEY ?? ''); toast(t('You will now be told about new leads and problems'), 'success'); }
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'all', label: t('All') },
    { id: 'unread', label: t('Unread'), count: unread },
    { id: 'reminders', label: t('Reminders'), count: reminders.length },
  ];

  return (
    <div
      class="pop fixed inset-x-2 bottom-2 z-[60] flex max-h-[80dvh] flex-col overflow-hidden pb-[env(safe-area-inset-bottom)] sm:absolute sm:inset-x-auto sm:right-0 sm:bottom-auto sm:mt-2 sm:max-h-[32rem] sm:w-[26rem] sm:pb-0"
      role="dialog" aria-label={t('Notifications')}
    >
      <header class="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 class="title text-sm font-bold">{t('Notifications')}</h2>
        {unread > 0 && <span class="pill bg-ocean-100 text-ocean-800">{t('{n} new', { n: unread })}</span>}
        <button class="ml-auto flex size-11 items-center justify-center rounded-lg text-muted hover:bg-subtle hover:text-ink" title={t('Notification settings')} aria-label={t('Notification settings')}
          onClick={() => { onClose(); go('/profile'); }}>
          <Settings2 class="size-4" />
        </button>
      </header>

      <nav class="flex gap-1 border-b border-line px-2 pt-2" role="tablist">
        {tabs.map((x) => (
          <button key={x.id} role="tab" aria-selected={tab === x.id} onClick={() => setTab(x.id)}
            class={`-mb-px flex min-h-11 min-w-11 items-center justify-center gap-1.5 border-b-2 px-3 py-2 text-xs font-semibold transition ${tab === x.id ? 'border-brand-600 text-brand-800' : 'border-transparent text-muted hover:text-ink'}`}>
            {x.label}
            {!!x.count && <span class={`rounded-full px-1.5 text-[10px] tabular-nums ${tab === x.id ? 'bg-brand-100 text-brand-800' : 'bg-subtle text-muted'}`}>{x.count}</span>}
          </button>
        ))}
      </nav>

      <div class="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <p class="px-6 py-10 text-center text-sm text-muted">
            {tab === 'unread' ? t('Everything has been read.') : tab === 'reminders' ? t('No reminders set.') : t('Nothing to report. Problems and reminders appear here.')}
          </p>
        ) : (
          <ul class="divide-y divide-line">
            {shown.map((n) => {
              const Icon = ICON[n.kind] ?? Bell;
              const later = n.remind_at && new Date(n.remind_at).getTime() > Date.now();
              return (
                <li key={n.id}>
                  <button class={`flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-subtle ${n.read_at ? '' : 'bg-ocean-50/40'}`} onClick={() => openItem(n)}>
                    <span class={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl ${TONE[n.kind] ?? 'bg-ocean-50 text-ocean-700'}`}><Icon class="size-4" /></span>
                    <span class="min-w-0 flex-1">
                      <span class="flex items-baseline gap-2">
                        <span class="min-w-0 flex-1 truncate text-sm font-semibold">{n.title}</span>
                        <span class="shrink-0 text-[11px] text-muted">{later ? new Date(n.remind_at!).toLocaleDateString() : timeAgo(n.created_at)}</span>
                      </span>
                      <span class="mt-0.5 block line-clamp-2 text-xs text-muted">{n.body}</span>
                      {later && <span class="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-amber-800"><AlarmClock class="size-3" />{t('Reminder')}</span>}
                    </span>
                    {n.link ? <ChevronRight class="mt-2 size-4 shrink-0 text-slate-300" /> : null}
                    {!n.read_at && <span class="mt-2 size-2 shrink-0 rounded-full bg-ocean-600" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer class="flex items-center gap-2 border-t border-line px-3 py-2">
        {supportsPush() && (
          <button class="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold text-muted hover:bg-subtle hover:text-ink" onClick={() => void togglePush()}>
            {push === 'granted' ? <><BellOff class="size-3.5" />{t('Turn off alerts')}</> : <><BellRing class="size-3.5" />{t('Alert me here')}</>}
          </button>
        )}
        <button class="ml-auto inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold text-ocean-700 hover:bg-ocean-50 disabled:opacity-40"
          disabled={!unread} onClick={() => void markRead(list.filter((n) => !n.read_at).map((n) => n.id))}>
          <CheckCheck class="size-3.5" />{t('Mark all read')}
        </button>
      </footer>
    </div>
  );
}
