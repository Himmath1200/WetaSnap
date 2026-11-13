import { useEffect, useMemo, useState } from 'preact/hooks';
import { Plus, LifeBuoy, MessageSquarePlus, Send, UserCheck, Inbox, X } from 'lucide-preact';
import { Avatar, Empty, Field, FilterChip, FilterPopover, Select, Sheet, Spinner } from '../components/ui';
import { backend } from '../lib/backend';
import { toast, useStore } from '../lib/store';
import { session } from '../lib/session';
import { isOnline } from '../lib/net';
import { timeAgo } from '../lib/id';
import { t, tn } from '../lib/i18n';
import type { SupportTicket, TicketPriority, TicketStatus } from '../lib/types';

/** S11 · Support — WeTano Super Admin answers tickets; a Client Admin raises and follows their own. */

const STATUS_META: Record<TicketStatus, { label: string; cls: string }> = {
  open: { label: 'Open', cls: 'bg-subtle text-muted' },
  waiting: { label: 'Waiting', cls: 'bg-amber-100 text-amber-800' },
  resolved: { label: 'Resolved', cls: 'bg-brand-100 text-brand-800' },
  closed: { label: 'Closed', cls: 'bg-subtle text-muted' },
};
const PRIORITY_META: Record<TicketPriority, { label: string; cls: string }> = {
  low: { label: 'Low', cls: 'bg-subtle text-muted' },
  normal: { label: 'Normal', cls: 'bg-subtle text-muted' },
  high: { label: 'High', cls: 'bg-amber-100 text-amber-800' },
  urgent: { label: 'Urgent', cls: 'bg-red-100 text-red-700' },
};
const StatusPill = ({ status }: { status: TicketStatus }) => <span class={`pill ${STATUS_META[status].cls}`}>{t(STATUS_META[status].label)}</span>;
const PriorityPill = ({ priority }: { priority: TicketPriority }) => <span class={`pill ${PRIORITY_META[priority].cls}`}>{t(PRIORITY_META[priority].label)}</span>;

/** A ticket needs you when the last message came from the other side and it is not finished. */
function needsYou(ticket: SupportTicket, isWetano: boolean) {
  if (ticket.status === 'resolved' || ticket.status === 'closed') return false;
  const last = ticket.messages[ticket.messages.length - 1];
  if (!last) return isWetano;
  return isWetano ? !last.from_wetano : last.from_wetano;
}

function useWide() {
  const [wide, setWide] = useState(() => (typeof matchMedia === 'function' ? matchMedia('(min-width: 768px)').matches : true));
  useEffect(() => {
    const m = matchMedia('(min-width: 768px)');
    const h = () => setWide(m.matches);
    m.addEventListener('change', h);
    return () => m.removeEventListener('change', h);
  }, []);
  return wide;
}

export default function Support() {
  const s = useStore(session)!;
  const isWetano = s.person.role === 'super_admin';
  const wide = useWide();

  const [rows, setRows] = useState<SupportTicket[] | null>(null);
  const [status, setStatus] = useState<TicketStatus | ''>('');
  const [roleFilter, setRoleFilter] = useState<'all' | 'organizations' | 'organizers' | 'individuals'>('all');
  const [companyId, setCompanyId] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [compose, setCompose] = useState(false);

  const load = async (keep?: string) => {
    try {
      if (isOnline()) {
        // First check and flush any queued offline tickets
        try {
          const raw = localStorage.getItem('wetasnap_offline_tickets');
          const queue: { subject: string; body: string; priority: TicketPriority }[] = raw ? JSON.parse(raw) : [];
          if (queue.length > 0) {
            const b = await backend();
            for (const item of queue) {
              await b.openTicket(item).catch(() => {});
            }
            localStorage.removeItem('wetasnap_offline_tickets');
            toast(t('Online: Your offline support requests have been submitted!'), 'success', 3000);
          }
        } catch {}
      }

      const list = await (await backend()).tickets({ status, company_id: isWetano ? companyId : (s.person.company_id ?? s.person.id) });
      setRows(list);
      setSelectedId((cur) => keep ?? (cur && list.some((x) => x.id === cur) ? cur : null));
    } catch (e) {
      setRows([]);
      toast((e as Error).message, 'error');
    }
  };
  useEffect(() => { setRows(null); void load(); }, [status, companyId, isOnline()]);

  /** Newest activity first, with the ones waiting on you pulled to the top, filtered by category. */
  const list = useMemo(() => {
    const sorted = [...(rows ?? [])].sort((a, b) => {
      const d = Number(needsYou(b, isWetano)) - Number(needsYou(a, isWetano));
      return d !== 0 ? d : b.updated_at.localeCompare(a.updated_at);
    });

    if (!isWetano || roleFilter === 'all') return sorted;

    return sorted.filter((t) => {
      const name = (t.company_name || '').toLowerCase();
      if (roleFilter === 'individuals') {
        return name.includes('(individual)') || !t.company_id;
      }
      if (roleFilter === 'organizers') {
        return name.includes('(organizer)') || name.includes('organizer');
      }
      if (roleFilter === 'organizations') {
        return !name.includes('(individual)') && !name.includes('(organizer)') && Boolean(t.company_id);
      }
      return true;
    });
  }, [rows, isWetano, roleFilter]);

  const companies = useMemo(() => {
    const by = new Map<string, string>();
    for (const r of rows ?? []) if (r.company_id) by.set(r.company_id, r.company_name);
    return [...by].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const selected = list.find((x) => x.id === selectedId) ?? null;
  const replace = (next: SupportTicket) => setRows((cur) => (cur ?? []).map((x) => (x.id === next.id ? next : x)));

  const thread = selected
    ? <Thread ticket={selected} isWetano={isWetano} onChanged={replace} onClose={() => setSelectedId(null)} />
    : <Empty icon={<MessageSquarePlus class="size-6" />} title={t('Pick a request')} text={t('Choose a request on the left to read the conversation.')} />;

  return (
    <div class="mx-auto max-w-7xl">
      <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 class="text-xl font-bold">{t('Support')}</h1>
          <p class="text-sm text-muted">{isWetano ? t('Manage requests from organizations, event organizers, and solo individuals.') : t('Ask WeTano for help and follow your requests here.')}</p>
        </div>
        {!isWetano && <button class="btn-primary" onClick={() => setCompose(true)}><Plus class="size-4" />{t('New request')}</button>}
      </div>

      {isWetano && (
        <div class="mb-4 flex flex-wrap items-center gap-2">
          {(
            [
              ['all', t('All Requests')],
              ['organizations', t('Organizations')],
              ['organizers', t('Event Organizers')],
              ['individuals', t('Solo Individuals')],
            ] as const
          ).map(([key, label]) => {
            const count = (rows ?? []).filter((t) => {
              const name = (t.company_name || '').toLowerCase();
              if (key === 'all') return true;
              if (key === 'individuals') return name.includes('(individual)') || !t.company_id;
              if (key === 'organizers') return name.includes('(organizer)') || name.includes('organizer');
              return !name.includes('(individual)') && !name.includes('(organizer)') && Boolean(t.company_id);
            }).length;

            return (
              <button
                key={key}
                type="button"
                onClick={() => setRoleFilter(key)}
                class={`flex items-center gap-2 rounded-xl border px-3.5 py-2 text-xs font-semibold transition ${
                  roleFilter === key
                    ? 'border-brand-500 bg-brand-50 text-brand-700 shadow-sm font-bold'
                    : 'border-line bg-surface text-muted hover:border-brand-300 hover:text-ink'
                }`}
              >
                <span>{label}</span>
                <span class={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${roleFilter === key ? 'bg-brand-600 text-white' : 'bg-subtle text-muted'}`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div class="mb-3 flex flex-wrap items-center gap-2">
        {/* Status and company live behind the filter button, as on every other list screen. */}
        <FilterPopover label={t('Filter requests')} count={(status ? 1 : 0) + (companyId ? 1 : 0)}
          onClear={() => { setStatus(''); setCompanyId(''); }}>
          <div>
            <span class="label">{t('Status')}</span>
            <div class="flex flex-wrap gap-2">
              {(Object.keys(STATUS_META) as TicketStatus[]).map((k) => (
                <FilterChip key={k} on={status === k} onClick={() => setStatus(status === k ? '' : k)}>{t(STATUS_META[k].label)}</FilterChip>
              ))}
            </div>
          </div>
          {isWetano && (
            <div>
              <span class="label">{t('Company')}</span>
              <Select class="w-full" label={t('Company')} value={companyId} onChange={setCompanyId}
                options={[{ value: '', label: t('All companies') }, ...companies.map((c) => ({ value: c.id, label: c.name }))]} />
            </div>
          )}
        </FilterPopover>
        {status && (
          <span class="inline-flex min-h-11 items-center gap-1 rounded-full bg-ocean-50 pl-3 text-xs font-semibold text-ocean-800">
            {t(STATUS_META[status].label)}
            <button class="-my-2 flex size-10 items-center justify-center rounded-full hover:bg-ocean-100" onClick={() => setStatus('')} aria-label={`${t('Remove filter')} ${t(STATUS_META[status].label)}`}><X class="size-3.5" /></button>
          </span>
        )}
        {companyId && (
          <span class="inline-flex min-h-11 items-center gap-1 rounded-full bg-ocean-50 pl-3 text-xs font-semibold text-ocean-800">
            {companies.find((c) => c.id === companyId)?.name ?? t('Company')}
            <button class="-my-2 flex size-10 items-center justify-center rounded-full hover:bg-ocean-100" onClick={() => setCompanyId('')} aria-label={t('Remove filter')}><X class="size-3.5" /></button>
          </span>
        )}
      </div>

      <div class="grid gap-4 md:grid-cols-[320px_1fr] lg:grid-cols-[380px_1fr]">
        <div class="card overflow-hidden">
          {!rows ? <div class="flex justify-center py-16"><Spinner class="size-6 text-brand-700" /></div>
            : list.length === 0 ? (
              <Empty icon={<Inbox class="size-6" />}
                title={isWetano ? t('No requests match') : t('No requests yet')}
                text={isWetano ? t('Change the filters to see more.') : t('Stuck on something? Send us a request and we will reply here.')} />
            ) : (
              <>
                <ul class="divide-y divide-line">
                  {list.map((ticket) => {
                    const on = ticket.id === selectedId;
                    const unread = needsYou(ticket, isWetano);
                    return (
                      <li key={ticket.id}>
                        <button class={`flex min-h-11 w-full items-start gap-3 px-4 py-3 text-left transition ${on ? 'bg-brand-50/80 border-l-4 border-l-brand-600' : unread ? 'bg-emerald-500/5 hover:bg-emerald-500/10' : 'hover:bg-subtle'}`} onClick={() => setSelectedId(ticket.id)}>
                          <span class={`mt-1.5 size-2.5 shrink-0 rounded-full ${unread ? 'bg-emerald-500 animate-pulse' : 'bg-transparent'}`} aria-hidden="true" />
                          <span class="min-w-0 flex-1">
                            <div class="flex items-center gap-1.5 flex-wrap">
                              <span class={`truncate text-sm ${unread ? 'font-bold text-ink' : 'font-semibold text-ink'}`}>{ticket.subject}</span>
                              {unread && (
                                <span class="pill bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30 text-[10px] font-bold">
                                  {isWetano ? t('Reply needed') : t('New reply')}
                                </span>
                              )}
                            </div>
                            <span class="block truncate text-xs text-muted mt-0.5">
                              {ticket.number}{isWetano ? ` · ${ticket.company_name}` : ''} · {timeAgo(ticket.updated_at)}
                            </span>
                            <span class="mt-1 flex flex-wrap gap-1"><StatusPill status={ticket.status} /><PriorityPill priority={ticket.priority} /></span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <p class="border-t border-line px-4 py-2 text-xs text-muted">{tn(list.length, '{n} request', '{n} requests')}</p>
              </>
            )}
        </div>

        {/* Laptop: the conversation sits beside the list. Phone: it opens in a sheet. */}
        {wide ? <div class="card flex min-h-[28rem] flex-col overflow-hidden">{thread}</div> : (
          <Sheet open={!!selected} onClose={() => setSelectedId(null)} wide title={selected?.subject ?? ''}>
            {selected && thread}
          </Sheet>
        )}
      </div>

      {compose && <ComposeSheet onClose={() => setCompose(false)} onDone={(made) => { setCompose(false); void load(made.id); }} />}
    </div>
  );
}

// ---------------------------------------------------------------- conversation
function Thread({ ticket, isWetano, onChanged, onClose }: {
  ticket: SupportTicket; isWetano: boolean; onChanged: (t: SupportTicket) => void; onClose: () => void;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [assignee, setAssignee] = useState(ticket.assigned_to ?? '');

  useEffect(() => { setBody(''); setAssignee(ticket.assigned_to ?? ''); }, [ticket.id]);

  async function reply() {
    if (!body.trim()) return;
    setBusy(true);
    try {
      onChanged(await (await backend()).replyTicket(ticket.id, body.trim()));
      setBody('');
      toast(t('Reply sent'), 'success');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  }

  async function change(status: TicketStatus, assigned?: string | null) {
    setBusy(true);
    try {
      onChanged(await (await backend()).setTicketStatus(ticket.id, status, assigned));
      toast(t('Request updated'), 'success');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  }

  const closed = ticket.status === 'closed';

  return (
    <>
      <header class="border-b border-line px-4 py-3">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="min-w-0 flex-1 truncate font-bold">{ticket.subject}</h2>
          <StatusPill status={ticket.status} />
          <PriorityPill priority={ticket.priority} />
        </div>
        <p class="mt-0.5 text-xs text-muted">
          {ticket.number} · {ticket.company_name} · {t('opened by {who}', { who: ticket.opened_by })}
          {ticket.assigned_to ? ` · ${t('assigned to {who}', { who: ticket.assigned_to })}` : ''}
        </p>
        {isWetano && (
          <div class="mt-3 flex flex-wrap items-end gap-2">
            <label class="min-w-0 flex-1 sm:max-w-60">
              <span class="label">{t('Assigned to')}</span>
              <input class="input" type="email" placeholder={t('name@wetano.com')} value={assignee} onInput={(e) => setAssignee(e.currentTarget.value)} />
            </label>
            <button class="btn-secondary px-3" disabled={busy} onClick={() => void change(ticket.status, assignee.trim() || null)}>
              <UserCheck class="size-4" />{t('Assign')}
            </button>
            <label class="min-w-0">
              <span class="label">{t('Status')}</span>
              <select class="input w-auto min-w-36" value={ticket.status} disabled={busy} onChange={(e) => void change(e.currentTarget.value as TicketStatus, ticket.assigned_to)}>
                {(Object.keys(STATUS_META) as TicketStatus[]).map((k) => <option key={k} value={k}>{t(STATUS_META[k].label)}</option>)}
              </select>
            </label>
          </div>
        )}
      </header>

      <div class="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {/* The opening message is messages[0]; fall back to the body only for tickets without a thread. */}
        {ticket.messages.length === 0 && <Message author={ticket.opened_by} at={ticket.created_at} body={ticket.body} fromWetano={false} isWetano={isWetano} />}
        {ticket.messages.map((m) => (
          <Message key={m.id} author={m.author} at={m.at} body={m.body} fromWetano={m.from_wetano} isWetano={isWetano} />
        ))}
      </div>

      <footer class="border-t border-line px-4 py-3">
        {closed ? (
          <p class="text-sm text-muted">{t('This request is closed. Open a new one if you still need help.')}</p>
        ) : (
          <div class="flex items-end gap-2">
            <label class="min-w-0 flex-1">
              <span class="sr-only">{t('Your reply')}</span>
              <textarea class="input" rows={2} placeholder={t('Write a reply…')} value={body} onInput={(e) => setBody(e.currentTarget.value)} />
            </label>
            {/* Green is the main action here for WeTano; a Client Admin's main green button is “New request”. */}
            <button class={isWetano ? 'btn-primary' : 'btn-secondary'} disabled={busy || !body.trim()} onClick={() => void reply()}>
              {busy ? <Spinner /> : <Send class="size-4" />}<span class="hidden sm:inline">{t('Send')}</span>
            </button>
          </div>
        )}
        {!isWetano && !closed && (
          <button class="btn-ghost mt-1 px-2 text-xs" disabled={busy} onClick={() => void change('closed', ticket.assigned_to)}>{t('Close this request')}</button>
        )}
        <button class="btn-ghost mt-1 px-2 text-xs md:hidden" onClick={onClose}>{t('Back to the list')}</button>
      </footer>
    </>
  );
}

function Message({ author, at, body, fromWetano, isWetano }: { author: string; at: string; body: string; fromWetano: boolean; isWetano: boolean }) {
  const mine = fromWetano === isWetano;
  return (
    <article class={`flex gap-2 ${mine ? 'flex-row-reverse' : ''}`}>
      <Avatar name={author} size="size-8" />
      <div class={`min-w-0 max-w-[85%] rounded-2xl px-3 py-2 ${mine ? 'bg-brand-50' : 'bg-subtle'}`}>
        <p class="text-xs font-semibold">
          {author}
          {fromWetano && <span class="pill ml-1 bg-ocean-100 text-ocean-800">{t('WeTano')}</span>}
        </p>
        <p class="mt-0.5 text-sm whitespace-pre-wrap">{body}</p>
        <p class="mt-1 text-[11px] text-muted">{new Date(at).toLocaleString()}</p>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- new request (Client Admin)
function ComposeSheet({ onClose, onDone }: { onClose: () => void; onDone: (t: SupportTicket) => void }) {
  const s = useStore(session);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function send() {
    setErr('');
    if (!subject.trim()) { setErr(t('Give your request a short subject.')); return; }
    if (body.trim().length < 5) { setErr(t('Please describe what is happening.')); return; }
    setBusy(true);
    try {
      if (!isOnline()) {
        // Queue ticket locally in offline outbox
        const offlineId = `offline-${Date.now()}`;
        const queuedTicket: SupportTicket = {
          id: offlineId,
          number: 'QUEUE',
          company_id: '',
          company_name: '',
          opened_by: s?.person.email ?? '',
          subject: subject.trim(),
          body: body.trim(),
          priority,
          status: 'open',
          assigned_to: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          messages: [
            {
              id: `msg-${Date.now()}`,
              author: 'You',
              from_wetano: false,
              body: body.trim(),
              at: new Date().toISOString(),
            },
          ],
        };

        const existingQueue = JSON.parse(localStorage.getItem('wetasnap_offline_tickets') || '[]');
        existingQueue.push({ subject: subject.trim(), body: body.trim(), priority });
        localStorage.setItem('wetasnap_offline_tickets', JSON.stringify(existingQueue));

        toast(t('Offline: Support request saved locally. It will automatically send as soon as you reconnect to internet!'), 'info', 4000);
        onDone(queuedTicket);
        return;
      }

      const made = await (await backend()).openTicket({ subject: subject.trim(), body: body.trim(), priority });
      toast(t('Request {number} sent — we will reply here.', { number: made.number }), 'success');
      onDone(made);
    } catch (e) {
      if ((e as Error).message === 'offline') {
        const existingQueue = JSON.parse(localStorage.getItem('wetasnap_offline_tickets') || '[]');
        existingQueue.push({ subject: subject.trim(), body: body.trim(), priority });
        localStorage.setItem('wetasnap_offline_tickets', JSON.stringify(existingQueue));
        toast(t('Offline: Request queued. Will auto-send when connection returns.'), 'info', 4000);
        onClose();
      } else {
        setErr((e as Error).message);
      }
    } finally { setBusy(false); }
  }

  return (
    <Sheet open onClose={onClose} wide title={<span class="flex items-center gap-2"><LifeBuoy class="size-4" />{t('New request')}</span>}
      footer={<button class="btn-primary ml-auto min-w-32" disabled={busy} onClick={() => void send()}>{busy ? <Spinner /> : t('Send request')}</button>}>
      <div class="space-y-4">
        <Field label={t('Subject')} for="sup-subject">
          <input id="sup-subject" class="input" value={subject} onInput={(e) => setSubject(e.currentTarget.value)} placeholder={t('Scans are not reaching our CRM')} />
        </Field>
        <Field label={t('What is happening?')} for="sup-body" hint={t('Tell us what you did, what you expected and what happened instead.')}>
          <textarea id="sup-body" class="input" rows={6} value={body} onInput={(e) => setBody(e.currentTarget.value)} />
        </Field>
        <div>
          <span class="label">{t('Priority')}</span>
          <div class="flex flex-wrap gap-2">
            {(Object.keys(PRIORITY_META) as TicketPriority[]).map((k) => (
              <button key={k} type="button" aria-pressed={priority === k} onClick={() => setPriority(k)}
                class={`chip min-h-11 ${priority === k ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line bg-surface'}`}>
                {t(PRIORITY_META[k].label)}
              </button>
            ))}
          </div>
        </div>
        {err && <p class="text-sm font-medium text-red-700">{err}</p>}
      </div>
    </Sheet>
  );
}
