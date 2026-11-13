import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Check, Search, SlidersHorizontal, X } from 'lucide-preact';
import { activeFilterCount, INTEREST_META, STATUS_META, TAG_META } from '../lib/leads';
import { emptyFilters, type EventItem, type Interest, type LeadFilters, type LeadStatus, type Tag } from '../lib/types';
import { today } from '../lib/id';
import { t } from '../lib/i18n';

interface Props {
  value: LeadFilters;
  onChange: (f: LeadFilters) => void;
  events: EventItem[];
  /** Admin only: filter by who captured the lead. */
  staff?: { id: string; name: string }[];
  tags?: Tag[];
  placeholder?: string;
  /** Extra controls to the right of the filter button (e.g. Export, Import). */
  actions?: ComponentChildren;
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/**
 * Search box with a Filter button right next to it (client brief). Events, captured by and tags
 * are multi-select; dates have Today / Last 7 / Last 30 days presets. Active filters show as
 * removable chips (LEAD-06).
 */
export function SearchFilterBar({ value, onChange, events, staff, tags, placeholder, actions }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(value.q);
  const wrap = useRef<HTMLDivElement>(null);
  const count = activeFilterCount(value);
  const set = (patch: Partial<LeadFilters>) => onChange({ ...value, ...patch });
  const toggle = (key: 'event_ids' | 'captured_by' | 'tag_ids', id: string) =>
    set({ [key]: value[key].includes(id) ? value[key].filter((x) => x !== id) : [...value[key], id] });

  // Debounced free-text search. It reads the latest filters when it fires, so a filter picked
  // while typing is not lost (D-27).
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    if (q === value.q) return;
    const h = setTimeout(() => onChange({ ...latest.current, q }), 180);
    return () => clearTimeout(h);
  }, [q]);
  useEffect(() => setQ(value.q), [value.q]);

  // Close the popover on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', click);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', click); document.removeEventListener('keydown', key); };
  }, [open]);

  const datePreset = value.from === today() && value.to === today() ? 'today'
    : value.from === daysAgo(6) && !value.to ? '7d'
    : value.from === daysAgo(29) && !value.to ? '30d'
    : value.from || value.to ? 'custom' : '';
  const dateLabel = { today: t('Today'), '7d': t('Last 7 days'), '30d': t('Last 30 days'), custom: `${value.from || '…'} → ${value.to || '…'}`, '': '' }[datePreset];

  const chips: { key: string; label: string; clear: Partial<LeadFilters> }[] = [
    ...value.event_ids.map((id) => ({ key: `e${id}`, label: events.find((e) => e.id === id)?.name ?? t('Event'), clear: { event_ids: value.event_ids.filter((x) => x !== id) } })),
    ...value.captured_by.map((id) => ({ key: `s${id}`, label: `${t('By')} ${staff?.find((s) => s.id === id)?.name ?? '…'}`, clear: { captured_by: value.captured_by.filter((x) => x !== id) } })),
    ...value.tag_ids.map((id) => ({ key: `t${id}`, label: tags?.find((x) => x.id === id)?.name ?? t('Tag'), clear: { tag_ids: value.tag_ids.filter((x) => x !== id) } })),
  ];
  if (value.status) chips.push({ key: 'st', label: t(STATUS_META[value.status].label), clear: { status: '' } });
  if (value.interest) chips.push({ key: 'in', label: t(INTEREST_META[value.interest].label), clear: { interest: '' } });
  if (datePreset) chips.push({ key: 'dt', label: dateLabel, clear: { from: '', to: '' } });

  return (
    <div class="space-y-2">
      <div class="flex items-center gap-2" ref={wrap}>
        <div class="relative min-w-0 flex-1">
          <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search" class="input pr-9 pl-9" value={q} placeholder={placeholder ?? t('Search name, company, email…')}
            onInput={(e) => setQ(e.currentTarget.value)} aria-label={t('Search leads')}
          />
          {q && (
            <button class="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-1 text-slate-400 hover:bg-slate-100" onClick={() => { setQ(''); set({ q: '' }); }} aria-label={t('Clear search')}>
              <X class="size-4" />
            </button>
          )}
        </div>

        <div class="relative">
          <button
            class={`btn relative border px-3 ${count ? 'border-ocean-600 bg-ocean-50 text-ocean-700' : 'border-line bg-surface text-slate-700 hover:border-ocean-500 hover:text-ocean-700'}`}
            onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog" aria-label={t('Filter leads')}
          >
            <SlidersHorizontal class="size-4" />
            <span class="hidden sm:inline">{t('Filter')}</span>
            {count > 0 && <span class="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-ocean-600 text-[11px] font-bold text-white">{count}</span>}
          </button>

          {open && <div class="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm sm:hidden" onClick={() => setOpen(false)} />}
          {open && (
            <div class="fixed inset-x-0 bottom-0 z-40 max-h-[80dvh] overflow-y-auto rounded-t-3xl border border-line bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl sm:absolute sm:inset-x-auto sm:top-full sm:right-0 sm:bottom-auto sm:mt-2 sm:max-h-[70vh] sm:w-[340px] sm:rounded-2xl sm:pb-4" role="dialog" aria-label={t('Filter leads')}>
              <div class="mb-3 flex items-center justify-between">
                <p class="text-sm font-bold">{t('Filter leads')}</p>
                <button class="inline-flex min-h-11 items-center text-xs font-semibold text-ocean-700 hover:underline disabled:opacity-40" disabled={!count} onClick={() => onChange({ ...emptyFilters(), q: value.q })}>{t('Clear all')}</button>
              </div>
              <div class="space-y-4">
                {events.length > 0 && (
                  <MultiSelect label={t('Events')} all={t('All events')} selected={value.event_ids}
                    items={events.map((e) => ({ id: e.id, label: e.name, note: e.status === 'closed' ? t('Closed') : '' }))}
                    onToggle={(id) => toggle('event_ids', id)} onClear={() => set({ event_ids: [] })} />
                )}
                {staff && staff.length > 0 && (
                  <MultiSelect label={t('Captured by')} all={t('Everyone')} selected={value.captured_by}
                    items={staff.map((s) => ({ id: s.id, label: s.name }))}
                    onToggle={(id) => toggle('captured_by', id)} onClear={() => set({ captured_by: [] })} />
                )}
                {tags && tags.length > 0 && (
                  <MultiSelect label={t('Tags')} all={t('Any tag')} selected={value.tag_ids}
                    items={tags.map((g) => ({ id: g.id, label: g.name, dot: TAG_META[g.colour].dot }))}
                    onToggle={(id) => toggle('tag_ids', id)} onClear={() => set({ tag_ids: [] })} />
                )}
                <ChipGroup<LeadStatus> label={t('Status')} value={value.status} onChange={(status) => set({ status })}
                  items={(Object.keys(STATUS_META) as LeadStatus[]).map((k) => ({ id: k, label: t(STATUS_META[k].label) }))} />
                <ChipGroup<Interest> label={t('Interest')} value={value.interest} onChange={(interest) => set({ interest })}
                  items={(Object.keys(INTEREST_META) as Interest[]).map((k) => ({ id: k, label: t(INTEREST_META[k].label) }))} />
                <div>
                  <span class="label">{t('Date')}</span>
                  <div class="flex flex-wrap gap-2">
                    <Chip on={datePreset === 'today'} onClick={() => set(datePreset === 'today' ? { from: '', to: '' } : { from: today(), to: today() })}>{t('Today')}</Chip>
                    <Chip on={datePreset === '7d'} onClick={() => set(datePreset === '7d' ? { from: '', to: '' } : { from: daysAgo(6), to: '' })}>{t('Last 7 days')}</Chip>
                    <Chip on={datePreset === '30d'} onClick={() => set(datePreset === '30d' ? { from: '', to: '' } : { from: daysAgo(29), to: '' })}>{t('Last 30 days')}</Chip>
                  </div>
                  <div class="mt-2 grid grid-cols-2 gap-2">
                    <input type="date" class="input" value={value.from} max={value.to || undefined} onChange={(e) => set({ from: e.currentTarget.value })} aria-label={t('From date')} />
                    <input type="date" class="input" value={value.to} min={value.from || undefined} onChange={(e) => set({ to: e.currentTarget.value })} aria-label={t('To date')} />
                  </div>
                </div>
              </div>
              <button class="btn-primary mt-4 w-full" onClick={() => setOpen(false)}>{t('Show results')}</button>
            </div>
          )}
        </div>

        {actions}
      </div>

      {chips.length > 0 && (
        <div class="flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <span key={c.key} class="inline-flex items-center gap-1 rounded-full bg-ocean-50 py-1 pr-1 pl-2.5 text-xs font-semibold text-ocean-800">
              {c.label}
              <button class="-my-2 flex size-10 items-center justify-center rounded-full hover:bg-ocean-100" onClick={() => set(c.clear)} aria-label={`${t('Remove filter')} ${c.label}`}><X class="size-3.5" /></button>
            </span>
          ))}
          {chips.length > 1 && <button class="inline-flex min-h-11 items-center px-1 text-xs font-semibold text-muted hover:text-ink" onClick={() => onChange({ ...emptyFilters(), q: value.q })}>{t('Clear all')}</button>}
        </div>
      )}
    </div>
  );
}

/** Checkbox list — “All …” when nothing is ticked, so the common case needs no clicks. */
function MultiSelect({ label, all, items, selected, onToggle, onClear }: {
  label: string; all: string; selected: string[]; onToggle: (id: string) => void; onClear: () => void;
  items: { id: string; label: string; note?: string; dot?: string }[];
}) {
  return (
    <div>
      <div class="flex items-baseline justify-between">
        <span class="label">{label}</span>
        {selected.length > 0 && <button class="tap mb-1 text-[11px] font-semibold text-ocean-700 hover:underline" onClick={onClear}>{t('Clear')}</button>}
      </div>
      <div class="max-h-44 overflow-y-auto rounded-xl border border-line">
        <button class={`flex w-full items-center gap-2 min-h-11 px-3 py-2 text-left text-sm ${selected.length === 0 ? 'bg-brand-50 font-semibold text-brand-800' : 'hover:bg-subtle'}`} onClick={onClear}>
          <span class={`flex size-4 items-center justify-center rounded border ${selected.length === 0 ? 'border-brand-600 bg-brand-600 text-white' : 'border-line'}`}>{selected.length === 0 && <Check class="size-3" />}</span>
          {all}
        </button>
        {items.map((i) => {
          const on = selected.includes(i.id);
          return (
            <button key={i.id} class={`flex w-full items-center gap-2 border-t border-line min-h-11 px-3 py-2 text-left text-sm ${on ? 'bg-ocean-50' : 'hover:bg-subtle'}`} onClick={() => onToggle(i.id)} aria-pressed={on}>
              <span class={`flex size-4 shrink-0 items-center justify-center rounded border ${on ? 'border-ocean-600 bg-ocean-600 text-white' : 'border-line'}`}>{on && <Check class="size-3" />}</span>
              {i.dot && <span class={`size-2 shrink-0 rounded-full ${i.dot}`} />}
              <span class="min-w-0 flex-1 truncate">{i.label}</span>
              {i.note && <span class="shrink-0 text-[11px] text-muted">{i.note}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ComponentChildren }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      class={`chip ${on ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line bg-surface text-slate-700 hover:border-ocean-500'}`}>
      {children}
    </button>
  );
}

function ChipGroup<T extends string>({ label, value, onChange, items }: { label: string; value: T | ''; onChange: (v: T | '') => void; items: { id: T; label: string }[] }) {
  return (
    <div>
      <span class="label">{label}</span>
      <div class="flex flex-wrap gap-2">
        <Chip on={!value} onClick={() => onChange('')}>{t('Any')}</Chip>
        {items.map((i) => <Chip key={i.id} on={value === i.id} onClick={() => onChange(value === i.id ? '' : i.id)}>{i.label}</Chip>)}
      </div>
    </div>
  );
}
