import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { UserPlus, Pencil, Search, Phone, Check, SlidersHorizontal, X, UserCheck, UserX, Link, Copy } from 'lucide-preact';
import { Avatar, Dialog, Field, SortHeader, SortMenu, Spinner } from '../components/ui';
import { backend, type Invitation, type PersonRow, type SeatInfo } from '../lib/backend';
import { InvitationNote } from '../components/Invitation';
import { useStore, toast } from '../lib/store';
import { config, session } from '../lib/session';
import { LICENCE_META } from '../lib/licence';
import { isEmail } from '../lib/validate';
import { t, tn } from '../lib/i18n';
import type { Person, Role, Sort } from '../lib/types';

const STATUS = {
  active: 'bg-brand-100 text-brand-800',
  invited: 'bg-amber-100 text-amber-800',
  expired: 'bg-subtle text-muted',
  deactivated: 'bg-subtle text-muted',
} as const;

type TeamRole = Exclude<Role, 'super_admin' | 'individual' | 'organizer'>;
type TeamStatus = PersonRow['status'];

interface TeamFilters { roles: TeamRole[]; statuses: TeamStatus[]; event_ids: string[] }
const noFilters = (): TeamFilters => ({ roles: [], statuses: [], event_ids: [] });

const ROLE_LABEL: Record<TeamRole, string> = { client_admin: 'Admin', staff: 'Staff' };
const STATUS_ORDER: TeamStatus[] = ['active', 'invited', 'expired', 'deactivated'];
const ROLE_RANK: Record<TeamRole, number> = { staff: 0, client_admin: 1 };
const STATUS_RANK: Record<TeamStatus, number> = { deactivated: 0, expired: 1, invited: 2, active: 3 };

/** S6 · Team — seats, people, search + filter, sortable list, invite (ADM-01, ADM-02, AUTH-05/06/08). */
export default function Team() {
  const cfg = useStore(config);
  const [people, setPeople] = useState<PersonRow[] | null>(null);
  const [seats, setSeats] = useState<SeatInfo | null>(null);
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<TeamFilters>(noFilters);
  const [sort, setSort] = useState<Sort>({ key: 'name', dir: 'asc' });
  const [edit, setEdit] = useState<PersonRow | 'new' | null>(null);

  const load = async () => {
    const b = await backend();
    const [p, s] = await Promise.all([b.people(), b.seats()]);
    setPeople(p); setSeats(s);
  };
  useEffect(() => { void load().catch((e) => toast((e as Error).message, 'error')); }, []);

  const full = seats ? seats.used >= seats.seats : false;
  const eventName = (id: string) => cfg.events.find((e) => e.id === id)?.name ?? id;

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const dir = sort.dir === 'asc' ? 1 : -1;
    const key = (p: PersonRow): string | number => {
      switch (sort.key) {
        case 'role': return ROLE_RANK[(p.role === 'client_admin' ? 'client_admin' : 'staff')];
        case 'status': return STATUS_RANK[p.status];
        case 'leads': return p.lead_count;
        default: return p.name.toLowerCase() || p.email.toLowerCase();
      }
    };
    return (people ?? [])
      .filter((p) => !needle || `${p.name} ${p.email}`.toLowerCase().includes(needle))
      .filter((p) => !filters.roles.length || filters.roles.includes(p.role as TeamRole))
      .filter((p) => !filters.statuses.length || filters.statuses.includes(p.status))
      .filter((p) => !filters.event_ids.length || filters.event_ids.some((id) => p.event_ids.includes(id)))
      .sort((a, b) => {
        const x = key(a); const y = key(b);
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
        return String(x).localeCompare(String(y)) * dir;
      });
  }, [people, q, filters, sort]);

  const events = (p: PersonRow) => (p.event_ids.length > 1 ? t('{n} events', { n: p.event_ids.length }) : p.event_name ?? '—');
  const until = (p: PersonRow) => (p.access_ends_on ? t('Access until {date}', { date: new Date(p.access_ends_on).toLocaleDateString() }) : t('No end date'));

  async function togglePersonActive(p: PersonRow) {
    if (p.id === session.get()?.person.id) {
      toast(t('You cannot deactivate your own account.'), 'error');
      return;
    }
    const nextActive = !p.active;
    if (nextActive && full) {
      toast(t('Cannot activate: all {n} seats are currently in use.', { n: seats?.seats ?? 0 }), 'error');
      return;
    }
    try {
      const b = await backend();
      await b.updatePerson({
        id: p.id,
        name: p.name,
        phone: p.phone,
        role: p.role,
        event_ids: p.event_ids,
        default_event_id: p.default_event_id,
        access_ends_on: p.access_ends_on,
        active: nextActive,
      });
      toast(nextActive ? t('{name} activated', { name: p.name }) : t('{name} deactivated — seat freed', { name: p.name }), 'success');
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  const currentPerson = session.get()?.person;
  const isOrganizer = currentPerson?.role === 'organizer';
  const orgSlug = (currentPerson?.name || 'organizer').toLowerCase().replace(/[^a-z0-9]/g, '');
  const vanityDomain = `wetano.${orgSlug}.com`;
  const liveReferralUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/signin?ref=${currentPerson?.referral_code ?? ''}`
    : `https://app.wetasnap.com/signin?ref=${currentPerson?.referral_code ?? ''}`;

  return (
    <div class="mx-auto w-full max-w-7xl">
      <div class="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 class="text-2xl font-bold tracking-tight text-ink">{isOrganizer ? t('Event Team & Scanners') : t('Team')}</h1>
          <p class="text-sm text-muted mt-0.5">{isOrganizer ? t('Members who joined your event via your referral link.') : t('Manage team members, roles and event access')}</p>
        </div>
        {!isOrganizer && (
          <button class="btn-primary min-h-10 px-4 text-xs font-semibold gap-1.5" disabled={full} onClick={() => setEdit('new')} title={full ? t('All seats are in use') : ''}>
            <UserPlus class="size-4" />{t('Invite person')}
          </button>
        )}
      </div>

      {isOrganizer && currentPerson?.referral_code && (
        <div class="card mb-4 p-4 border-l-4 border-l-purple-600 bg-gradient-to-r from-purple-500/10 via-subtle to-transparent space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-xs font-bold text-muted uppercase tracking-wider flex items-center gap-1.5">
              <Link class="size-3.5 text-purple-600" />
              <span>{t('Your Event Referral Link')}</span>
            </span>
            <span class="font-mono text-xs font-bold text-purple-700 dark:text-purple-300 px-2.5 py-0.5 rounded-full bg-purple-500/15 border border-purple-500/30">
              {currentPerson.referral_code}
            </span>
          </div>

          <div class="flex items-center gap-2 rounded-xl border border-line bg-surface p-2.5">
            <div class="min-w-0 flex-1">
              <span class="block font-mono text-xs font-bold text-ink truncate">{vanityDomain}</span>
              <span class="block font-mono text-[11px] text-muted truncate">{liveReferralUrl}</span>
            </div>
            <button
              class="btn-primary h-8 px-3 text-xs font-bold gap-1.5 shrink-0"
              onClick={() => {
                navigator.clipboard.writeText(liveReferralUrl);
                toast(t('Referral link copied to clipboard!'), 'success');
              }}
            >
              <Copy class="size-3.5 text-white" />
              <span>{t('Copy link')}</span>
            </button>
          </div>
          <p class="text-[11px] text-muted">
            {t('Send this link to your team members or attendees. When they register, they automatically join your event as active scanners.')}
          </p>
        </div>
      )}

      {seats && (
        <div class="card mb-4 p-4 border-l-4 border-l-brand-600 bg-subtle/40">
          <div class="flex flex-wrap items-center justify-between gap-2 text-sm">
            <div>
              <span class="font-bold text-ink text-base">
                {isOrganizer
                  ? t('{used} of {seats} allowed team logins used', { used: seats.used, seats: seats.seats })
                  : t('{used} of {seats} seats used', { used: seats.used, seats: seats.seats })}
              </span>
              <p class="text-xs text-muted mt-0.5">
                {isOrganizer
                  ? t('Login quota provisioned by your Super Admin. Active members can scan leads until 24 hours after the event.')
                  : t('Seat capacity determined by your Super Admin licence. You can activate, deactivate and invite members within this limit.')}
              </p>
            </div>
            <span class="flex items-center gap-2 text-xs text-muted">
              <span class={`pill ${LICENCE_META[seats.status].cls}`}>{t(LICENCE_META[seats.status].label)}</span>
              {t('Event concludes: {date}', { date: new Date(seats.licence.ends_on).toLocaleDateString() })}
            </span>
          </div>
          <div class="mt-3 h-2.5 overflow-hidden rounded-full bg-subtle">
            <div class={`h-full rounded-full transition-all ${full ? 'bg-amber-500' : 'bg-gradient-to-r from-brand-500 to-ocean-600'}`} style={{ width: `${Math.min(100, (seats.used / seats.seats) * 100)}%` }} />
          </div>
          {full && <p class="mt-2 text-xs font-semibold text-amber-800">{isOrganizer ? t('All allowed logins for this event have been claimed. Contact your Super Admin to expand your login quota.') : t('All seats are in use. Deactivate someone to free their seat, or request more seats from your WeTano Super Admin.')}</p>}
        </div>
      )}

      <div class="mb-3 space-y-2">
        <div class="flex items-center gap-2">
          <div class="relative min-w-0 max-w-sm flex-1">
            <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
            <input type="search" class="input pl-9" placeholder={t('Search people')} value={q} onInput={(e) => setQ(e.currentTarget.value)} aria-label={t('Search people')} />
          </div>
          <TeamFilterButton value={filters} onChange={setFilters} events={cfg.events.map((e) => ({ id: e.id, name: e.name }))} />
          <span class="ml-auto hidden lg:block" />
          <div class="lg:hidden">
            <SortMenu sort={sort} onSort={setSort} options={sortOptions()} />
          </div>
        </div>
        <FilterChips value={filters} onChange={setFilters} eventName={eventName} />
      </div>

      <div class="card overflow-hidden">
        {!people ? <div class="flex justify-center py-12"><Spinner class="size-6 text-brand-700" /></div> : (
          <>
            {/* Laptop table */}
            <table class="hidden w-full text-sm lg:table">
              <thead class="bg-subtle text-left text-xs font-semibold text-muted">
                <tr>
                  <SortHeader id="name" sort={sort} onSort={setSort}>{t('Name')}</SortHeader>
                  <SortHeader id="role" sort={sort} onSort={setSort}>{t('Role')}</SortHeader>
                  <th class="px-4 py-2.5">{t('Events')}</th>
                  <SortHeader id="leads" sort={sort} onSort={setSort} align="right">{t('Leads captured')}</SortHeader>
                  <SortHeader id="status" sort={sort} onSort={setSort}>{t('Status')}</SortHeader>
                  <th class="px-4 py-2.5 text-right"><span class="sr-only">{t('Actions')}</span></th>
                </tr>
              </thead>
              <tbody class="divide-y divide-line">
                {list.map((p) => (
                  <tr key={p.id} class="transition hover:bg-brand-50/40">
                    <td class="px-4 py-3">
                      <div class="flex items-center gap-3">
                        <Avatar name={p.name} />
                        <div class="min-w-0">
                          <p class="truncate font-semibold">{p.name}</p>
                          <p class="truncate text-xs text-muted">{p.email}{p.phone ? ` · ${p.phone}` : ''}</p>
                        </div>
                      </div>
                    </td>
                    <td class="px-4 py-3">{p.role === 'client_admin' ? t('Admin') : t('Staff')}</td>
                    <td class="px-4 py-3">
                      <p class="truncate">{events(p)}</p>
                      <p class="text-xs text-muted">{until(p)}</p>
                    </td>
                    <td class="px-4 py-3 text-right tabular-nums">{p.lead_count}</td>
                    <td class="px-4 py-3"><span class={`pill capitalize ${STATUS[p.status]}`}>{t(p.status)}</span></td>
                    <td class="px-4 py-3 text-right">
                      <div class="inline-flex items-center gap-1.5 justify-end">
                        {p.id !== session.get()?.person.id && (
                          p.active ? (
                            <button
                              class="btn-secondary h-8 px-2.5 text-xs text-red-600 hover:bg-red-50 inline-flex items-center gap-1"
                              onClick={() => void togglePersonActive(p)}
                              title={t('Deactivate account (frees up seat)')}
                            >
                              <UserX class="size-3.5" />
                              <span class="hidden sm:inline">{t('Deactivate')}</span>
                            </button>
                          ) : (
                            <button
                              class="btn-secondary h-8 px-2.5 text-xs text-emerald-700 hover:bg-emerald-50 inline-flex items-center gap-1"
                              disabled={full}
                              onClick={() => void togglePersonActive(p)}
                              title={full ? t('All seats in use') : t('Activate account')}
                            >
                              <UserCheck class="size-3.5" />
                              <span class="hidden sm:inline">{t('Activate')}</span>
                            </button>
                          )
                        )}
                        <button class="btn-ghost size-8 p-0 flex items-center justify-center rounded-lg hover:bg-subtle" onClick={() => setEdit(p)} aria-label={t('Edit')}>
                          <Pencil class="size-4 text-muted" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* Phone list */}
            <ul class="divide-y divide-line lg:hidden">
              {list.map((p) => (
                <li key={p.id} class="flex items-center gap-3 px-4 py-3">
                  <Avatar name={p.name} />
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-semibold">{p.name} <span class="ml-1 text-xs font-medium text-muted">{p.role === 'client_admin' ? t('Admin') : t('Staff')}</span></p>
                    <p class="truncate text-xs text-muted">{p.email}{p.phone ? ` · ${p.phone}` : ''}</p>
                    <p class="truncate text-xs text-muted">{events(p)}{p.access_ends_on ? ` · ${t('until {date}', { date: p.access_ends_on })}` : ''} · {tn(p.lead_count, '{n} lead', '{n} leads')}</p>
                  </div>
                  <span class={`pill capitalize ${STATUS[p.status]}`}>{t(p.status)}</span>
                  <div class="flex items-center gap-1 shrink-0">
                    {p.id !== session.get()?.person.id && (
                      p.active ? (
                        <button
                          class="btn-secondary h-8 px-2 text-xs text-red-600"
                          onClick={() => void togglePersonActive(p)}
                          title={t('Deactivate account')}
                        >
                          <UserX class="size-3.5" />
                        </button>
                      ) : (
                        <button
                          class="btn-secondary h-8 px-2 text-xs text-emerald-700"
                          disabled={full}
                          onClick={() => void togglePersonActive(p)}
                          title={t('Activate account')}
                        >
                          <UserCheck class="size-3.5" />
                        </button>
                      )
                    )}
                    <button class="btn-ghost size-8 p-0 flex items-center justify-center rounded-lg" onClick={() => setEdit(p)} aria-label={t('Edit')}>
                      <Pencil class="size-4 text-muted" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            {list.length === 0 && <p class="px-4 py-10 text-center text-sm text-muted">{t('Nobody matches this search or filter.')}</p>}
            <p class="border-t border-line px-4 py-2 text-xs text-muted">{tn(list.length, '{n} person', '{n} people')}</p>
          </>
        )}
      </div>

      <PersonDialog value={edit} onClose={() => setEdit(null)} onSaved={(close = true) => { if (close) setEdit(null); void load(); }} isOrganizer={isOrganizer} currentPerson={currentPerson} />
    </div>
  );
}

const sortOptions = () => [
  { id: 'name', label: t('Name') },
  { id: 'role', label: t('Role') },
  { id: 'status', label: t('Status') },
  { id: 'leads', label: t('Leads captured') },
];

const filterCount = (f: TeamFilters) => f.roles.length + f.statuses.length + f.event_ids.length;

/**
 * Filter popover for the people list — role, status and events. Written here rather than reusing
 * SearchFilterBar, which is typed for leads.
 */
function TeamFilterButton({ value, onChange, events }: { value: TeamFilters; onChange: (f: TeamFilters) => void; events: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const count = filterCount(value);

  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', click);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', click); document.removeEventListener('keydown', key); };
  }, [open]);

  const toggle = <K extends keyof TeamFilters>(k: K, id: TeamFilters[K][number]) => {
    const on = (value[k] as string[]).includes(id as string);
    onChange({ ...value, [k]: on ? (value[k] as string[]).filter((x) => x !== id) : [...(value[k] as string[]), id] } as TeamFilters);
  };

  return (
    <div class="relative" ref={wrap}>
      <button
        class={`btn relative border px-3 ${count ? 'border-ocean-600 bg-ocean-50 text-ocean-700' : 'border-line bg-surface text-muted hover:border-ocean-500 hover:text-ocean-700'}`}
        onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog" aria-label={t('Filter people')}
      >
        <SlidersHorizontal class="size-4" />
        <span class="hidden sm:inline">{t('Filter')}</span>
        {count > 0 && <span class="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-ocean-600 text-[11px] font-bold text-white">{count}</span>}
      </button>

      {open && <div class="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm sm:hidden" onClick={() => setOpen(false)} />}
      {open && (
        <div class="fixed inset-x-0 bottom-0 z-40 max-h-[80dvh] overflow-y-auto rounded-t-3xl border border-line bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl sm:absolute sm:inset-x-auto sm:top-full sm:right-0 sm:bottom-auto sm:mt-2 sm:max-h-[70vh] sm:w-[320px] sm:rounded-2xl sm:pb-4" role="dialog" aria-label={t('Filter people')}>
          <div class="mb-3 flex items-center justify-between">
            <p class="text-sm font-bold">{t('Filter people')}</p>
            <button class="inline-flex min-h-11 items-center text-xs font-semibold text-ocean-700 hover:underline disabled:opacity-40" disabled={!count} onClick={() => onChange(noFilters())}>{t('Clear all')}</button>
          </div>
          <div class="space-y-4">
            <div>
              <span class="label">{t('Role')}</span>
              <div class="flex flex-wrap gap-2">
                {(['client_admin', 'staff'] as TeamRole[]).map((r) => (
                  <FilterChip key={r} on={value.roles.includes(r)} onClick={() => toggle('roles', r)}>{t(ROLE_LABEL[r])}</FilterChip>
                ))}
              </div>
            </div>
            <div>
              <span class="label">{t('Status')}</span>
              <div class="flex flex-wrap gap-2">
                {STATUS_ORDER.map((st) => (
                  <FilterChip key={st} on={value.statuses.includes(st)} onClick={() => toggle('statuses', st)}><span class="capitalize">{t(st)}</span></FilterChip>
                ))}
              </div>
            </div>
            {events.length > 0 && (
              <div>
                <div class="flex items-baseline justify-between">
                  <span class="label">{t('Events')}</span>
                  {value.event_ids.length > 0 && <button class="tap mb-1 text-[11px] font-semibold text-ocean-700 hover:underline" onClick={() => onChange({ ...value, event_ids: [] })}>{t('Clear')}</button>}
                </div>
                <div class="max-h-44 overflow-y-auto rounded-xl border border-line">
                  <button class={`flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm ${value.event_ids.length === 0 ? 'bg-brand-50 font-semibold text-brand-800' : 'hover:bg-subtle'}`} onClick={() => onChange({ ...value, event_ids: [] })}>
                    <span class={`flex size-4 items-center justify-center rounded border ${value.event_ids.length === 0 ? 'border-brand-600 bg-brand-600 text-white' : 'border-line'}`}>{value.event_ids.length === 0 && <Check class="size-3" />}</span>
                    {t('All events')}
                  </button>
                  {events.map((e) => {
                    const on = value.event_ids.includes(e.id);
                    return (
                      <button key={e.id} class={`flex min-h-11 w-full items-center gap-2 border-t border-line px-3 py-2 text-left text-sm ${on ? 'bg-ocean-50' : 'hover:bg-subtle'}`} onClick={() => toggle('event_ids', e.id)} aria-pressed={on}>
                        <span class={`flex size-4 shrink-0 items-center justify-center rounded border ${on ? 'border-ocean-600 bg-ocean-600 text-white' : 'border-line'}`}>{on && <Check class="size-3" />}</span>
                        <span class="min-w-0 flex-1 truncate">{e.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <button class="btn-secondary mt-4 w-full" onClick={() => setOpen(false)}>{t('Show results')}</button>
        </div>
      )}
    </div>
  );
}

function FilterChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ComponentChildren }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      class={`chip ${on ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line bg-surface text-muted hover:border-ocean-500'}`}>
      {children}
    </button>
  );
}

/** Active filters as removable chips, the same shape the leads list uses. */
function FilterChips({ value, onChange, eventName }: { value: TeamFilters; onChange: (f: TeamFilters) => void; eventName: (id: string) => string }) {
  const chips = [
    ...value.roles.map((r) => ({ key: `r${r}`, label: t(ROLE_LABEL[r]), next: { ...value, roles: value.roles.filter((x) => x !== r) } })),
    ...value.statuses.map((st) => ({ key: `s${st}`, label: t(st), next: { ...value, statuses: value.statuses.filter((x) => x !== st) } })),
    ...value.event_ids.map((id) => ({ key: `e${id}`, label: eventName(id), next: { ...value, event_ids: value.event_ids.filter((x) => x !== id) } })),
  ];
  if (!chips.length) return null;
  return (
    <div class="flex flex-wrap items-center gap-1.5">
      {chips.map((c) => (
        <span key={c.key} class="inline-flex items-center gap-1 rounded-full bg-ocean-50 py-1 pr-1 pl-2.5 text-xs font-semibold text-ocean-800 capitalize">
          {c.label}
          <button class="-my-2 flex size-10 items-center justify-center rounded-full hover:bg-ocean-100" onClick={() => onChange(c.next)} aria-label={`${t('Remove filter')} ${c.label}`}><X class="size-3.5" /></button>
        </span>
      ))}
      {chips.length > 1 && <button class="inline-flex min-h-11 items-center px-1 text-xs font-semibold text-muted hover:text-ink" onClick={() => onChange(noFilters())}>{t('Clear all')}</button>}
    </div>
  );
}

function PersonDialog({ value, onClose, onSaved, isOrganizer = false, currentPerson }: { value: PersonRow | 'new' | null; onClose: () => void; onSaved: (close?: boolean) => void; isOrganizer?: boolean; currentPerson?: Person }) {
  const cfg = useStore(config);
  const isNew = value === 'new';
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Exclude<Role, 'super_admin'>>('staff');
  const [phone, setPhone] = useState('');
  const [eventIds, setEventIds] = useState<string[]>([]);
  const [temp, setTemp] = useState(false);
  const [endsOn, setEndsOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  /** Set once the invitation is out: the dialog then shows what the person was sent. */
  const [sent, setSent] = useState<Invitation | null>(null);

  useEffect(() => {
    if (!value) { setSent(null); return; }    // closed: forget the invitation it was showing
    const p = value === 'new' ? null : value;
    setEmail(p?.email ?? ''); setName(p?.name ?? ''); setPhone(p?.phone ?? ''); setRole((p?.role as 'staff') ?? 'staff');
    setEventIds(p?.event_ids?.length ? p.event_ids : [cfg.events.find((e) => e.status === 'open')?.id].filter(Boolean) as string[]);
    setTemp(!!p?.access_ends_on); setEndsOn(p?.access_ends_on ?? ''); setErr(''); setSent(null);
  }, [value]);

  async function submit(active = true) {
    setErr('');
    if (isNew && !isEmail(email)) { setErr(t('Please enter a valid email address.')); return; }
    if (temp && !endsOn) { setErr(t('Choose the date their access ends.')); return; }

    // Organizer attendee validation: access date must be within event dates set by Super Admin
    if (isOrganizer && temp && endsOn) {
      const activeEvent = cfg.events.find((e) => e.id === (eventIds[0] || currentPerson?.default_event_id)) || cfg.events[0];
      const evStart = activeEvent?.starts_on || currentPerson?.event_ends_on; // fallback
      const evEnd = activeEvent?.ends_on || currentPerson?.event_ends_on;
      if (evEnd && (endsOn > evEnd || (evStart && endsOn < evStart))) {
        const msg = evStart
          ? t('The event dates are between {start} and {end}. Access date must be within this period.', {
              start: new Date(evStart).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }),
              end: new Date(evEnd).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }),
            })
          : t('The event ends on {end}. Access date cannot exceed this date.', {
              end: new Date(evEnd).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }),
            });
        setErr(msg);
        toast(msg, 'error', 6000);
        return;
      }
    }
    setBusy(true);
    try {
      const b = await backend();
      if (isNew) {
        // AUTH-08: the account is made without a password; they set one from the email (code + link).
        setSent(await b.invite({ email, name, phone, role, event_ids: eventIds, default_event_id: eventIds[0] ?? null, access_ends_on: temp ? endsOn : null }));
        toast(t('Invitation sent to {email}', { email }), 'success');
        onSaved(false);                       // refresh the list, keep the dialog on the invitation
        return;
      } else if (value) {
        await b.updatePerson({ id: value.id, name, phone, role, event_ids: eventIds, default_event_id: eventIds[0] ?? null, access_ends_on: temp ? endsOn : null, active });
        toast(active ? t('Saved') : t('{name} can no longer sign in', { name }), 'success');
      }
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const person = value && value !== 'new' ? value : null;
  /** You cannot lock yourself out: no self-deactivation or self-demotion (D-18). */
  const isSelf = !!person && person.id === session.get()?.person.id;
  if (value && sent) {
    return (
      <Dialog open onClose={onClose} title={t('Invitation sent')}
        footer={<button class="btn-primary ml-auto" onClick={onClose}>{t('Done')}</button>}>
        <InvitationNote email={email} invitation={sent} />
      </Dialog>
    );
  }

  return (
    <Dialog open={!!value} onClose={onClose} title={isNew ? t('Invite person') : t('Edit {name}', { name: person?.name ?? '' })}
      footer={<>
        {person && !isSelf && (person.active
          ? <button class="btn-ghost mr-auto text-red-700" disabled={busy} onClick={() => void submit(false)}>{t('Deactivate')}</button>
          : <button class="btn-ghost mr-auto text-brand-700" disabled={busy} onClick={() => void submit(true)}>{t('Reactivate')}</button>)}
        <button class="btn-ghost" onClick={onClose}>{t('Cancel')}</button>
        <button class="btn-primary" disabled={busy} onClick={() => void submit(person?.active ?? true)}>{busy ? <Spinner /> : isNew ? t('Send invite') : t('Save')}</button>
      </>}>
      <div class="space-y-3">
        <Field label={t('Email')} for="p-email">
          <input id="p-email" type="email" class="input" value={email} disabled={!isNew} onInput={(e) => setEmail(e.currentTarget.value)} placeholder="name@company.com" />
        </Field>
        <div class="grid gap-3 sm:grid-cols-2">
          <Field label={t('Name')} for="p-name">
            <input id="p-name" class="input" value={name} onInput={(e) => setName(e.currentTarget.value)} />
          </Field>
          <Field label={t('Mobile number')} for="p-phone" hint={t('Optional — so the team can reach them at the booth.')}>
            <div class="relative">
              <Phone class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
              <input id="p-phone" type="tel" inputMode="tel" class="input pl-9" value={phone} placeholder="+49 151 2345678" onInput={(e) => setPhone(e.currentTarget.value)} />
            </div>
          </Field>
        </div>
        <div>
          <span class="label">{t('Role')}</span>
          <div class="grid grid-cols-2 gap-2">
            {(['staff', 'client_admin'] as const).map((r) => (
              <button key={r} type="button" onClick={() => setRole(r)} aria-pressed={role === r} disabled={isSelf && r !== role}
                title={isSelf && r !== role ? t('You cannot change your own role') : undefined}
                class={`rounded-xl border px-3 py-2 text-left text-sm ${role === r ? 'border-brand-600 bg-brand-50' : 'border-line'}`}>
                <span class="block font-semibold">{r === 'staff' ? t('Staff') : t('Admin')}</span>
                <span class="text-xs text-muted">{r === 'staff' ? t('Scans cards, sees own leads') : t('Manages leads, team and settings')}</span>
              </button>
            ))}
          </div>
          {isSelf && <p class="mt-1.5 text-xs text-muted">{t('This is your own account — you cannot deactivate it or change its role. Ask another admin.')}</p>}
        </div>
        <div>
          <div class="flex items-baseline justify-between">
            <span class="label">{t('Events')}</span>
            <span class="mb-1 text-[11px] text-muted">{eventIds.length ? t('First one is their default') : t('None selected')}</span>
          </div>
          <div class="max-h-40 overflow-y-auto rounded-xl border border-line">
            {cfg.events.filter((e) => e.status === 'open').map((e) => {
              const on = eventIds.includes(e.id);
              return (
                <button key={e.id} type="button" aria-pressed={on}
                  class={`flex w-full items-center gap-2 border-b border-line min-h-11 px-3 py-2 text-left text-sm last:border-b-0 ${on ? 'bg-ocean-50' : 'hover:bg-subtle'}`}
                  onClick={() => setEventIds(on ? eventIds.filter((x) => x !== e.id) : [...eventIds, e.id])}>
                  <span class={`flex size-4 shrink-0 items-center justify-center rounded border ${on ? 'border-ocean-600 bg-ocean-600 text-white' : 'border-line'}`}>{on && <Check class="size-3" />}</span>
                  <span class="min-w-0 flex-1 truncate">{e.name}</span>
                  {on && eventIds[0] === e.id && <span class="pill bg-brand-100 text-brand-800">{t('Default')}</span>}
                </button>
              );
            })}
            {cfg.events.filter((e) => e.status === 'open').length === 0 && <p class="px-3 py-3 text-sm text-muted">{t('No open events yet — add one in Settings.')}</p>}
          </div>
        </div>
        {isOrganizer ? (
          <div class="space-y-3 pt-1 border-t border-line">
            <label class="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" class="size-4 accent-purple-700" checked={temp} onChange={(e) => setTemp(e.currentTarget.checked)} />
              {t('Custom attendee access end date')}
            </label>
            {temp && (() => {
              const activeEvent = cfg.events.find((e) => e.id === (eventIds[0] || currentPerson?.default_event_id)) || cfg.events[0];
              const evStart = activeEvent?.starts_on;
              const evEnd = activeEvent?.ends_on || currentPerson?.event_ends_on;
              return (
                <Field
                  label={t('Attendee access end date')}
                  for="p-end"
                  hint={evStart && evEnd
                    ? t('Event dates: {start} to {end}', {
                        start: new Date(evStart).toLocaleDateString([], { month: 'short', day: 'numeric' }),
                        end: new Date(evEnd).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }),
                      })
                    : evEnd
                    ? t('Event ends on: {end}', { end: new Date(evEnd).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) })
                    : t('Must be within event duration set by Super Admin.')}
                >
                  <input
                    id="p-end"
                    type="date"
                    class="input"
                    value={endsOn}
                    min={evStart ?? new Date().toISOString().slice(0, 10)}
                    max={evEnd ?? undefined}
                    onChange={(e) => setEndsOn(e.currentTarget.value)}
                  />
                </Field>
              );
            })()}
          </div>
        ) : (
          <>
            <label class="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" class="size-4 accent-brand-700" checked={temp} onChange={(e) => setTemp(e.currentTarget.checked)} />
              {t('Temporary staff — access ends on a date')}
            </label>
            {temp && (
              <Field label={t('Access end date')} for="p-end" hint={t('After this date they cannot sign in; leads already on their phone are still accepted.')}>
                <input id="p-end" type="date" class="input" value={endsOn} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setEndsOn(e.currentTarget.value)} />
              </Field>
            )}
          </>
        )}
        {err && <p class="text-sm font-medium text-red-700">{err}</p>}
      </div>
    </Dialog>
  );
}
