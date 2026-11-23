import { useEffect, useMemo, useState } from 'preact/hooks';
import { QrCode, UserPlus, List, ArrowRight, Store, CheckCheck, ChevronRight, TrendingUp, Users, Zap, Calendar, Sparkles, Trash } from 'lucide-preact';
import { useStore } from '../lib/store';
import { config, session, pullConfig } from '../lib/session';
import { db, type LocalLead } from '../lib/db';
import { useLive } from '../lib/useLive';
import { leadName, leadCompany } from '../lib/leads';
import { timeAgo, initials } from '../lib/id';
import { backend, type SeatInfo } from '../lib/backend';
import { linkFor } from '../lib/portal';
import { t } from '../lib/i18n';
import { isOnline } from '../lib/net';
import { syncNow, syncState } from '../lib/sync';

function interestPill(interest: string | null): { label: string; cls: string } | null {
  if (interest === 'hot') return { label: 'Hot', cls: 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/30' };
  if (interest === 'warm') return { label: 'Warm', cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30' };
  if (interest === 'cold') return { label: 'Cold', cls: 'bg-slate-500/15 text-slate-600 dark:text-slate-400 border border-slate-500/30' };
  return null;
}

function eventDay(event: { starts_on: string; ends_on: string } | undefined): string | null {
  if (!event) return null;
  const start = new Date(event.starts_on).getTime();
  const end = new Date(event.ends_on).getTime();
  const now = Date.now();
  if (now < start || now > end + 86_400_000) return null;
  const day = Math.floor((now - start) / 86_400_000) + 1;
  const total = Math.ceil((end - start) / 86_400_000) + 1;
  return `Day ${day} of ${total}`;
}

function StatCard({ icon: Icon, value, label, tone = 'default' }: {
  icon: typeof TrendingUp; value: string | number; label: string; tone?: 'emerald' | 'rose' | 'ocean' | 'amber' | 'default';
}) {
  const cls = tone === 'emerald'
    ? 'border-emerald-500/25 bg-gradient-to-br from-emerald-500/10 via-emerald-500/5 to-transparent'
    : tone === 'rose'
    ? 'border-rose-500/25 bg-gradient-to-br from-rose-500/10 via-rose-500/5 to-transparent'
    : tone === 'ocean'
    ? 'border-sky-500/25 bg-gradient-to-br from-sky-500/10 via-sky-500/5 to-transparent'
    : tone === 'amber'
    ? 'border-amber-500/25 bg-gradient-to-br from-amber-500/10 via-amber-500/5 to-transparent'
    : 'border-line bg-surface';

  const iconCls = tone === 'emerald'
    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
    : tone === 'rose'
    ? 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
    : tone === 'ocean'
    ? 'bg-sky-500/15 text-sky-600 dark:text-sky-400'
    : tone === 'amber'
    ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
    : 'bg-subtle text-muted';

  const textCls = tone === 'emerald'
    ? 'text-emerald-600 dark:text-emerald-400'
    : tone === 'rose'
    ? 'text-rose-600 dark:text-rose-400'
    : tone === 'ocean'
    ? 'text-sky-600 dark:text-sky-400'
    : tone === 'amber'
    ? 'text-amber-600 dark:text-amber-400'
    : 'text-ink';

  return (
    <div class={`card p-4 flex flex-col gap-1 transition-all hover:scale-[1.01] ${cls}`}>
      <div class={`w-8 h-8 rounded-lg flex items-center justify-center mb-1 ${iconCls}`}>
        <Icon class="size-4" />
      </div>
      <span class={`text-2xl font-bold tracking-tight ${textCls}`}>{value}</span>
      <span class="text-xs text-muted font-medium">{label}</span>
    </div>
  );
}

export default function Home() {
  const s = useStore(session)!;
  const cfg = useStore(config);
  const sync = useStore(syncState);
  const online = isOnline();
  const role = s.person.role;

  const event = cfg.events.find((e) => e.id === s.event_id);
  const dayBadge = eventDay(event);

  const myLeads = useLive<LocalLead[]>(
    () => db.leads.toArray(),
    [s.person.id],
    [],
  );

  const personalLeads = useMemo(() => {
    return role === 'client_admin'
      ? myLeads
      : myLeads.filter((l) => l.captured_by === s.person.id);
  }, [myLeads, role, s.person.id]);

  const todayLeads = useMemo(() => {
    const today = new Date().toDateString();
    return personalLeads.filter((l) => !l.deleted_at && new Date(l.created_at).toDateString() === today);
  }, [personalLeads]);

  const hotLeads = useMemo(() => personalLeads.filter((l) => !l.deleted_at && l.interest === 'hot'), [personalLeads]);
  const totalLeads = useMemo(() => personalLeads.filter((l) => !l.deleted_at), [personalLeads]);
  const activeScans = role === 'individual' ? totalLeads.length : (s.person.monthly_scans ?? 0);
  const recycledLeads = useMemo(() => personalLeads.filter((l) => Boolean(l.deleted_at)), [personalLeads]);
  const recentLeads = useMemo(() => totalLeads.slice(0, 5), [totalLeads]);

  const [seats, setSeats] = useState<SeatInfo | null>(null);
  useEffect(() => {
    if (role === 'client_admin' && online) {
      backend().then((b) => b.seats()).then(setSeats).catch(() => {});
    }
  }, [role, online]);

  useEffect(() => {
    if (online) {
      void syncNow();
      void pullConfig();
    }
  }, [online]);

  const scanLimit = (seats?.licence as any)?.scans_per_month ?? 0;
  const scansUsed = totalLeads.length;
  const scanPct = scanLimit > 0 ? Math.min(100, Math.round((scansUsed / scanLimit) * 100)) : 0;

  const scanHref = linkFor(role, '/scan-v2');
  const leadsHref = linkFor(role, '/leads');
  const myLeadsHref = role === 'individual' ? leadsHref : linkFor(role, '/my-leads');

  const firstName = s.person.name.split(' ')[0] ?? s.person.name;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div class="w-full max-w-7xl mx-auto">

      {/* ── Desktop: 2-column; Mobile: single column ── */}
      <div class="flex flex-col md:flex-row md:gap-8 md:items-start">

        {/* ── LEFT / MAIN column ── */}
        <div class="flex flex-col gap-5 flex-1 min-w-0">

          {/* Greeting */}
          <section class="flex items-start justify-between gap-4 pt-1">
            <div>
              <p class="text-xs text-muted font-medium mb-0.5 uppercase tracking-wider">{t(greeting)}</p>
              <h1 class="font-display text-2xl md:text-3xl font-bold tracking-tight text-ink leading-tight">{firstName} 👋</h1>
              <p class="text-sm text-muted mt-1">
                {s.company ? <>{s.company.name}<span class="mx-1.5 text-line">·</span></> : null}
                {role === 'client_admin' ? t('Client Admin') : role === 'organizer' ? t('Event Organizer') : role === 'individual' ? (s.person.plan === 'pro' ? t('Individual (Pro)') : t('Individual (Solo)')) : t('Staff')}
              </p>
            </div>
            <div class={`hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-semibold ${
              online ? 'bg-brand-50 border-brand-200 text-brand-700' : 'bg-amber-50 border-amber-200 text-amber-700'
            }`}>
              <span class={`w-2 h-2 rounded-full ${online ? 'bg-brand-500 animate-pulse' : 'bg-amber-500'}`} />
              {online ? (sync.waiting ? t('Syncing…') : t('Live')) : t('Offline')}
            </div>
          </section>

          {/* Mobile status pill */}
          <div class={`md:hidden flex items-center gap-1.5 self-start px-2.5 py-1 rounded-full border text-[10px] font-semibold uppercase tracking-wider ${
            online ? 'bg-brand-50 border-brand-200 text-brand-700' : 'bg-amber-50 border-amber-200 text-amber-700'
          }`}>
            <span class={`w-1.5 h-1.5 rounded-full ${online ? 'bg-brand-500 animate-pulse' : 'bg-amber-500'}`} />
            {online ? (sync.waiting ? t('Syncing') : t('Live')) : t('Offline')}
          </div>

          {/* Primary CTA */}
          <section class="flex flex-col gap-2.5">
            <a
              href={scanHref}
              class="group relative w-full h-14 rounded-2xl font-semibold text-[15px] flex items-center justify-between px-5 transition-all active:scale-[0.99] shadow-md hover:shadow-lg bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-700 text-white"
            >
              <div class="flex items-center gap-3">
                <div class="w-9 h-9 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center shrink-0">
                  <QrCode class="size-5 text-white" />
                </div>
                <div>
                  <span class="block font-bold leading-tight text-white">{t('Scan New Lead')}</span>
                  <span class="block text-[11px] text-white/80 font-normal">{t('Camera · Upload · Manual')}</span>
                </div>
              </div>
              <div class="flex items-center justify-center w-7 h-7 rounded-full bg-white/20 group-hover:translate-x-0.5 transition-transform shrink-0">
                <ArrowRight class="size-4 text-white" />
              </div>
            </a>

            <div class={`grid gap-2.5 ${role === 'staff' ? 'grid-cols-1' : 'grid-cols-2'}`}>
              {role === 'individual' ? (
                <a href={linkFor(role, '/upgrade')} class="card h-11 px-4 flex items-center gap-2.5 text-ink font-semibold text-sm hover:bg-subtle transition-colors">
                  <Sparkles class="size-4 text-brand-600 shrink-0" />
                  {t('Pro Plan')}
                </a>
              ) : (
                <a href={myLeadsHref} class="card h-11 px-4 flex items-center gap-2.5 text-ink font-semibold text-sm hover:bg-subtle transition-colors">
                  <UserPlus class="size-4 text-brand-600 shrink-0" />
                  {t('My Leads')}
                </a>
              )}
              {role !== 'staff' && (
                <a href={leadsHref} class="card h-11 px-4 flex items-center gap-2.5 text-ink font-semibold text-sm hover:bg-subtle transition-colors">
                  <List class="size-4 text-muted shrink-0" />
                  {t('All Leads')}
                </a>
              )}
            </div>
          </section>

          {/* Stats grid */}
          <section>
            <h2 class="text-xs font-semibold text-muted uppercase tracking-wider mb-3">{t('Your activity')}</h2>
            <div class={`grid gap-3 ${recycledLeads.length > 0 ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3'}`}>
              <StatCard icon={Zap} value={todayLeads.length} label={t('Today')} tone="emerald" />
              <StatCard icon={TrendingUp} value={hotLeads.length} label={t('Hot leads')} tone="rose" />
              <StatCard icon={Users} value={totalLeads.length.toLocaleString()} label={t('Total')} tone="ocean" />
              {recycledLeads.length > 0 && (
                <a href={linkFor(role, '/profile')} class="block">
                  <StatCard icon={Trash} value={recycledLeads.length.toLocaleString()} label={t('Recycle bin')} tone="amber" />
                </a>
              )}
            </div>
          </section>

          {/* Recent leads */}
          <section>
            <div class="flex items-center justify-between mb-3">
              <h2 class="text-sm font-bold text-ink">{t('Recent leads')}</h2>
              {totalLeads.length > 0 && (
                <a href={myLeadsHref} class="text-xs text-brand-700 font-semibold hover:underline flex items-center gap-0.5">
                  {t('View all')} <ChevronRight class="size-3.5" />
                </a>
              )}
            </div>

            {recentLeads.length === 0 ? (
              <div class="card p-8 flex flex-col items-center gap-3 text-center">
                <div class="w-12 h-12 rounded-2xl bg-subtle flex items-center justify-center">
                  <QrCode class="size-6 text-muted" />
                </div>
                <div>
                  <p class="text-sm font-semibold text-ink">{t('No leads yet')}</p>
                  <p class="text-xs text-muted mt-0.5">{t('Scan your first card to get started.')}</p>
                </div>
                <a href={scanHref} class="btn-primary text-sm mt-1">{t('Scan now')}</a>
              </div>
            ) : (
              <div class="card divide-y divide-line overflow-hidden">
                {recentLeads.map((lead) => {
                  const pill = interestPill(lead.interest);
                  const synced = !lead.dirty && !lead.photo_pending;
                  return (
                    <a
                      key={lead.id}
                      href={myLeadsHref}
                      class="flex items-center justify-between gap-4 px-4 py-3 hover:bg-subtle transition-colors"
                    >
                      <div class="flex items-center gap-3 min-w-0">
                        <div class="w-9 h-9 rounded-xl brand-gradient flex items-center justify-center text-white text-xs font-bold shrink-0">
                          {initials(leadName(lead))}
                        </div>
                        <div class="min-w-0">
                          <div class="flex items-center gap-2 flex-wrap">
                            <span class="text-sm font-semibold text-ink truncate">{leadName(lead)}</span>
                            {pill && (
                              <span class={`px-1.5 py-0.5 rounded-md text-[9px] uppercase font-bold shrink-0 ${pill.cls}`}>
                                {pill.label}
                              </span>
                            )}
                          </div>
                          <p class="text-xs text-muted truncate mt-0.5">{leadCompany(lead)}</p>
                        </div>
                      </div>
                      <div class="flex flex-col items-end shrink-0 gap-0.5">
                        <span class={`text-[11px] flex items-center gap-0.5 font-medium ${synced ? 'text-brand-700' : 'text-muted'}`}>
                          {synced && <CheckCheck class="size-3.5" />}
                          {synced ? t('Synced') : t('Waiting')}
                        </span>
                        <span class="text-[10px] text-muted tabular-nums">{timeAgo(lead.created_at)}</span>
                      </div>
                    </a>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        {/* ── RIGHT / SIDEBAR column (desktop only) ── */}
        <aside class="hidden md:flex flex-col gap-5 w-72 shrink-0">

          {/* Individual Plan Quota card OR Company Event card */}
          {role === 'individual' ? (
            <div class="card p-5 flex flex-col gap-3.5 border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 via-subtle to-transparent">
              <div class="flex items-center justify-between">
                <span class="text-xs font-bold uppercase tracking-wider text-muted">{t('Your Plan')}</span>
                <span class={`pill text-[10px] font-bold uppercase ${s.person.plan === 'pro' ? 'bg-emerald-500 text-white' : 'bg-subtle border border-line text-muted'}`}>
                  {s.person.plan === 'pro' ? t('Pro') : t('Free Tier')}
                </span>
              </div>
              <div>
                <p class="font-extrabold text-ink text-base">
                  {s.person.plan === 'pro' ? t('Unlimited Scans') : `${activeScans} / 5 ${t('Scans')}`}
                </p>
                <p class="text-xs text-muted mt-0.5">
                  {s.person.plan === 'pro' ? t('Pro benefits active on all devices') : t('Monthly quota resets on next cycle')}
                </p>
              </div>
              {s.person.plan !== 'pro' && (
                <div class="w-full h-2 rounded-full bg-line overflow-hidden">
                  <div
                    class={`h-full rounded-full transition-all ${activeScans >= 5 ? 'bg-red-500' : 'bg-brand-500'}`}
                    style={{ width: `${Math.min(100, (activeScans / 5) * 100)}%` }}
                  />
                </div>
              )}
              {s.person.plan !== 'pro' ? (
                <a href={linkFor(role, '/upgrade')} class="btn-primary text-xs font-bold justify-center py-2 gap-1.5">
                  <Sparkles class="size-3.5" />
                  <span>{t('Upgrade to Pro ($100/mo)')}</span>
                </a>
              ) : (
                <a href={linkFor(role, '/upgrade')} class="btn-secondary text-xs font-bold justify-center py-2">
                  <span>{t('Plan details')}</span>
                </a>
              )}
            </div>
          ) : event ? (
            <div class="card p-5 flex flex-col gap-4">
              <div class="flex items-start justify-between gap-2">
                <div class="w-9 h-9 rounded-xl bg-brand-50 flex items-center justify-center shrink-0">
                  <Store class="size-5 text-brand-700" />
                </div>
                {dayBadge && (
                  <span class="px-2 py-0.5 rounded-full bg-brand-50 border border-brand-200 text-brand-700 text-[10px] font-bold uppercase tracking-wider shrink-0">
                    {dayBadge}
                  </span>
                )}
              </div>
              <div>
                <p class="font-bold text-ink text-sm leading-snug">{event.name}</p>
                {event.venue && <p class="text-xs text-muted mt-0.5">{event.venue}</p>}
                {event.booth && (
                  <span class="inline-flex items-center gap-1 mt-2 px-2 py-0.5 rounded-md bg-subtle border border-line text-xs text-muted font-medium">
                    <Store class="size-3" /> Booth {event.booth}
                  </span>
                )}
              </div>
              <div class="flex items-center gap-1.5 text-xs text-muted">
                <Calendar class="size-3.5" />
                <span>{new Date(event.starts_on).toLocaleDateString([], { month: 'short', day: 'numeric' })} – {new Date(event.ends_on).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
              </div>
              {(() => {
                const today = new Date(); today.setHours(0, 0, 0, 0);
                const start = new Date(event.starts_on); start.setHours(0, 0, 0, 0);
                const end = new Date(event.ends_on); end.setHours(23, 59, 59, 999);
                if (event.status === 'closed' || today > end) {
                  return <span class="self-start inline-flex items-center gap-1 rounded-full border border-line bg-subtle px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted">{t('Completed')}</span>;
                }
                if (today < start) {
                  return <span class="self-start inline-flex items-center gap-1 rounded-full border border-indigo-500/30 bg-indigo-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-indigo-700 dark:text-indigo-400"><span class="size-1.5 rounded-full bg-indigo-500" />{t('Upcoming')}</span>;
                }
                return <span class="self-start inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400"><span class="size-1.5 rounded-full bg-emerald-500 animate-pulse" />{t('Ongoing')}</span>;
              })()}
            </div>
          ) : (
            <div class="card p-5 flex flex-col items-center gap-3 text-center">
              <Store class="size-8 text-muted" />
              <div>
                <p class="text-sm font-semibold text-ink">{t('No event selected')}</p>
                <p class="text-xs text-muted mt-0.5">{t('Select an event from the menu.')}</p>
              </div>
            </div>
          )}

          {/* Scan quota (client_admin only) */}
          {scanLimit > 0 && (
            <div class="card p-5 flex flex-col gap-3">
              <div class="flex items-center justify-between">
                <p class="text-sm font-bold text-ink">{t('Plan usage')}</p>
                <span class={`text-xs font-bold ${scanPct >= 90 ? 'text-red-700' : 'text-brand-700'}`}>{scanPct}%</span>
              </div>
              <div class="w-full h-2 rounded-full bg-line overflow-hidden">
                <div
                  class={`h-full rounded-full transition-all ${scanPct >= 90 ? 'bg-red-500' : 'bg-brand-500'}`}
                  style={{ width: `${scanPct}%` }}
                />
              </div>
              <p class="text-xs text-muted">
                <span class="text-ink font-semibold">{scansUsed.toLocaleString()}</span>
                {' '}/{' '}
                <span>{scanLimit.toLocaleString()}</span>
                {' '}{t('scans used')}
              </p>
            </div>
          )}

          {/* Quick tips / CTA card */}
          <div class="card p-5 flex flex-col gap-3">
            <p class="text-xs font-bold text-muted uppercase tracking-wider">{t('Quick actions')}</p>
            <a href={scanHref} class="btn-primary w-full justify-center text-sm">
              <QrCode class="size-4" /> {t('Scan a card')}
            </a>
            <a href={role === 'staff' ? myLeadsHref : leadsHref} class="btn-secondary w-full justify-center text-sm">
              <List class="size-4" /> {role === 'staff' ? t('Open my leads') : t('Browse all leads')}
            </a>
          </div>
        </aside>
      </div>

      {/* ── Mobile: event strip (below the main content) ── */}
      {event && (
        <div class="md:hidden mt-5 card p-4 flex items-center gap-3">
          <div class="w-9 h-9 rounded-xl bg-brand-50 flex items-center justify-center shrink-0">
            <Store class="size-5 text-brand-700" />
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold text-ink truncate">{event.name}</p>
            <p class="text-xs text-muted truncate">{event.booth ? `Booth ${event.booth}` : event.venue}</p>
          </div>
          {dayBadge && (
            <span class="shrink-0 px-2 py-0.5 rounded-full bg-brand-50 border border-brand-200 text-brand-700 text-[10px] font-bold uppercase tracking-wider">
              {dayBadge}
            </span>
          )}
        </div>
      )}

      {/* ── Mobile: individual plan status ── */}
      {role === 'individual' && s.person.plan !== 'pro' && (
        <div class="md:hidden mt-4 card p-4 flex items-center justify-between gap-3 border-emerald-500/20 bg-gradient-to-r from-emerald-500/10 to-transparent">
          <div>
            <p class="text-xs font-bold text-ink">{t('Free Plan: {n}/5 scans used', { n: activeScans })}</p>
            <p class="text-[11px] text-muted">{t('Upgrade to Pro for unlimited card scanning.')}</p>
          </div>
          <a href={linkFor(role, '/upgrade')} class="btn-primary text-xs px-3 py-1.5 shrink-0 font-bold">
            {t('Upgrade')}
          </a>
        </div>
      )}

      {/* Mobile scan quota */}
      {scanLimit > 0 && (
        <div class="md:hidden mt-3 card p-4 flex flex-col gap-2">
          <div class="flex items-center justify-between text-xs">
            <span class="font-semibold text-ink">{t('Plan usage')}</span>
            <span class={`font-bold ${scanPct >= 90 ? 'text-red-700' : 'text-brand-700'}`}>
              {scansUsed.toLocaleString()} / {scanLimit.toLocaleString()}
            </span>
          </div>
          <div class="w-full h-1.5 rounded-full bg-line overflow-hidden">
            <div
              class={`h-full rounded-full ${scanPct >= 90 ? 'bg-red-500' : 'bg-brand-500'}`}
              style={{ width: `${scanPct}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
