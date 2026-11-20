import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { X, Loader2, CheckCircle2, AlertCircle, Info, Check, ChevronUp, ChevronDown, ChevronsUpDown, Search, SlidersHorizontal } from 'lucide-preact';
import { toasts, useStore } from '../lib/store';
import { INTEREST_META, STATUS_META } from '../lib/leads';
import { initials } from '../lib/id';
import { t } from '../lib/i18n';
import type { Interest, LeadStatus, Sort, SortDir } from '../lib/types';
import { APP_VERSION } from '../lib/version';

export function Spinner({ class: cls = 'size-5' }: { class?: string }) {
  return <Loader2 class={`${cls} animate-spin`} aria-hidden="true" />;
}

export function StatusPill({ status }: { status: LeadStatus }) {
  const m = STATUS_META[status];
  return <span class={`pill ${m.cls}`}>{t(m.label)}</span>;
}

export function InterestPill({ interest }: { interest: Interest | null }) {
  if (!interest) return <span class="text-xs text-muted">—</span>;
  const m = INTEREST_META[interest];
  return (
    <span class={`pill border ${m.cls}`}>
      <span class={`size-1.5 rounded-full ${m.dot}`} />
      {t(m.label)}
    </span>
  );
}

export function Avatar({ name, src, size = 'size-9' }: { name: string; src?: string | null; size?: string }) {
  if (src) return <img src={src} alt="" class={`${size} shrink-0 rounded-full border border-line object-cover`} />;
  return (
    <span class={`${size} brand-gradient inline-flex shrink-0 items-center justify-center rounded-full text-xs font-bold text-white`} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

/** Panel that slides from the right on laptops and up from the bottom on phones (lead panel, company panel). */
export function Sheet(props: { open: boolean; onClose: () => void; title: ComponentChildren; children: ComponentChildren; footer?: ComponentChildren; wide?: boolean; centered?: boolean }) {
  useEscape(props.open, props.onClose);
  if (!props.open) return null;
  const desktop = props.centered
    ? `md:my-auto md:max-h-[85dvh] md:rounded-3xl ${props.wide ? 'md:w-[680px]' : 'md:w-[540px]'}`
    : `md:max-h-none md:rounded-none md:rounded-l-3xl ${props.wide ? 'md:w-[560px]' : 'md:w-[460px]'}`;
  return (
    <div class={`fixed inset-0 z-50 flex items-end ${props.centered ? 'justify-center md:items-center md:p-6' : 'justify-end md:items-stretch'}`} role="dialog" aria-modal="true">
      <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={props.onClose} />
      <div class={`relative flex max-h-[92dvh] w-full flex-col rounded-t-3xl bg-surface shadow-2xl ${desktop} ${props.centered ? 'md:border md:border-line' : 'md:border-l md:border-line'}`}>
        <header class="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h2 class="min-w-0 truncate text-base font-bold">{props.title}</h2>
          <button class="btn-ghost -mr-2 size-11 px-0" onClick={props.onClose} aria-label={t('Close')}><X class="size-5" /></button>
        </header>
        <div class="flex-1 overflow-y-auto px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{props.children}</div>
        {props.footer && <footer class="flex items-center gap-2 border-t border-line px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{props.footer}</footer>}
      </div>
    </div>
  );
}

export function Dialog(props: { open: boolean; onClose: () => void; title: ComponentChildren; children: ComponentChildren; footer: ComponentChildren }) {
  useEscape(props.open, props.onClose);
  if (!props.open) return null;
  return (
    <div class="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true">
      <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={props.onClose} />
      <div class="relative w-full overflow-hidden rounded-t-3xl border border-line bg-surface shadow-2xl sm:max-w-md sm:rounded-3xl">
        <div class="px-5 pt-5 pb-2">
          <h2 class="text-base font-bold">{props.title}</h2>
        </div>
        <div class="max-h-[70dvh] overflow-y-auto px-5 py-2">{props.children}</div>
        <div class="flex justify-end gap-2 px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{props.footer}</div>
      </div>
    </div>
  );
}

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
}

export function Toaster() {
  const list = useStore(toasts);
  return (
    <div class="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-4" aria-live="polite">
      {list.map((m) => (
        <div key={m.id} class={`pointer-events-auto flex max-w-md items-start gap-2 rounded-2xl px-4 py-3 text-sm font-medium shadow-lg ${m.tone === 'error' ? 'bg-red-600 text-white' : m.tone === 'success' ? 'on-brand' : 'bg-ink text-white'}`}>
          {m.tone === 'error' ? <AlertCircle class="mt-0.5 size-4 shrink-0" /> : m.tone === 'success' ? <CheckCircle2 class="mt-0.5 size-4 shrink-0" /> : <Info class="mt-0.5 size-4 shrink-0" />}
          <span>{m.text}</span>
        </div>
      ))}
    </div>
  );
}

export function Empty({ icon, title, text }: { icon: ComponentChildren; title: string; text?: string }) {
  return (
    <div class="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div class="mb-3 flex size-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-700">{icon}</div>
      <p class="font-semibold">{title}</p>
      {text && <p class="mt-1 max-w-xs text-sm text-muted">{text}</p>}
    </div>
  );
}

export function Field(props: { label: string; hint?: string; error?: string | null; warn?: string | null; children: ComponentChildren; for?: string }) {
  return (
    <div>
      <label class="label" for={props.for}>{props.label}</label>
      {props.children}
      {props.error ? <p class="mt-1 text-xs font-medium text-red-700">{props.error}</p>
        : props.warn ? <p class="mt-1 text-xs font-medium text-amber-800">{props.warn}</p>
        : props.hint ? <p class="mt-1 text-xs text-muted">{props.hint}</p> : null}
    </div>
  );
}

export function Counter({ label, value, tone = 'brand' }: { label: string; value: number | string; tone?: 'brand' | 'ocean' | 'amber' | 'red' }) {
  const bar = { brand: 'bg-brand-500', ocean: 'bg-ocean-500', amber: 'bg-amber-400', red: 'bg-red-500' }[tone];
  return (
    <div class="card relative overflow-hidden px-4 py-3">
      <span class={`absolute inset-y-0 left-0 w-1 ${bar}`} />
      <p class="text-xs font-medium text-muted">{label}</p>
      <p class="mt-0.5 text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: string }[] }) {
  return (
    <div class="no-scrollbar -mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 md:mx-0 md:px-0" role="tablist">
      {items.map((i) => (
        <button key={i.id} role="tab" aria-selected={value === i.id} onClick={() => onChange(i.id)}
          class={`-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-semibold transition ${value === i.id ? 'border-brand-600 text-brand-800' : 'border-transparent text-muted hover:text-ink'}`}>
          {i.label}
        </button>
      ))}
    </div>
  );
}

/** Small print at the foot of every screen. */
export function Copyright({ class: cls = '' }: { class?: string }) {
  return (
    <p class={`py-4 text-center text-[11px] text-muted ${cls}`}>
      © {new Date().getFullYear()} WeTano Solutions · {t('WeTa Snap')} {APP_VERSION}
    </p>
  );
}

/** Tick box used for bulk selection in lists and tables. */
export function Tick({ on, indeterminate, onChange, label }: { on: boolean; indeterminate?: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button" role="checkbox" aria-checked={indeterminate ? 'mixed' : on} aria-label={label}
      onClick={(e) => { e.stopPropagation(); onChange(!on); }}
      class="group -m-3 flex size-11 shrink-0 items-center justify-center rounded-xl"
    >
      <span class={`flex size-5 items-center justify-center rounded-md border transition ${on || indeterminate ? 'border-ocean-600 bg-ocean-600 text-white' : 'border-line bg-surface group-hover:border-ocean-500'}`}>
        {indeterminate ? <span class="h-0.5 w-2.5 rounded bg-white" /> : on ? <Check class="size-3.5" /> : null}
      </span>
    </button>
  );
}

/** Clickable column header that cycles ascending → descending. */
export function SortHeader<T extends string>({ id, sort, onSort, children, class: cls = '', align = 'left' }: {
  id: T; sort: Sort; onSort: (s: Sort) => void; children: ComponentChildren; class?: string; align?: 'left' | 'right';
}) {
  const on = sort.key === id;
  const next: SortDir = on && sort.dir === 'asc' ? 'desc' : 'asc';
  return (
    <th class={`px-4 py-2.5 ${align === 'right' ? 'text-right' : 'text-left'} ${cls}`} aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button class={`-my-3 inline-flex min-h-11 min-w-11 items-center gap-1 font-semibold transition hover:text-ink ${on ? 'text-ink' : ''}`} onClick={() => onSort({ key: id, dir: next })}>
        {children}
        {on ? (sort.dir === 'asc' ? <ChevronUp class="size-3.5" /> : <ChevronDown class="size-3.5" />) : <ChevronsUpDown class="size-3 opacity-40" />}
      </button>
    </th>
  );
}

/** Sort control for phone lists, where there is no table header to click. */
export function SortMenu({ sort, onSort, options }: { sort: Sort; onSort: (s: Sort) => void; options: { id: string; label: string }[] }) {
  return (
    <label class="flex items-center gap-1.5 text-xs font-medium text-muted">
      {t('Sort')}
      <select class="input min-h-11 w-auto py-1 text-xs" value={`${sort.key}:${sort.dir}`}
        onChange={(e) => { const [key, dir] = e.currentTarget.value.split(':'); onSort({ key: key!, dir: dir as SortDir }); }}>
        {options.flatMap((o) => [
          <option key={`${o.id}:desc`} value={`${o.id}:desc`}>{o.label} ↓</option>,
          <option key={`${o.id}:asc`} value={`${o.id}:asc`}>{o.label} ↑</option>,
        ])}
      </select>
    </label>
  );
}

/** Bar that appears above a list when rows are ticked. */
export function BulkBar({ count, onClear, children }: { count: number; onClear: () => void; children: ComponentChildren }) {
  if (!count) return null;
  return (
    <div class="sticky top-16 z-10 mb-2 flex flex-wrap items-center gap-2 rounded-2xl border border-ocean-200 bg-ocean-50 px-3 py-2 shadow-sm">
      <span class="text-sm font-bold text-ocean-800">{t('{n} selected', { n: count })}</span>
      <div class="flex flex-wrap items-center gap-1.5">{children}</div>
      <button class="tap ml-auto text-xs font-semibold text-ocean-700 hover:underline" onClick={onClear}>{t('Clear')}</button>
    </div>
  );
}

/** On/off switch used across settings. */
export function Switch({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label class="flex cursor-pointer items-start justify-between gap-4 rounded-xl border border-line p-3">
      <span>
        <span class="block text-sm font-semibold">{label}</span>
        {hint && <span class="text-xs text-muted">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" class="peer sr-only" checked={on} onChange={(e) => onChange(e.currentTarget.checked)} />
      <span class={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition ${on ? 'bg-brand-600' : 'bg-slate-300'}`}>
        <span class={`absolute top-0.5 size-5 rounded-full bg-white shadow transition ${on ? 'left-5.5' : 'left-0.5'}`} />
      </span>
    </label>
  );
}

/**
 * Dropdown used in toolbars and forms. The native <select> keeps phones' own picker, but its
 * arrow and padding are replaced so it lines up with buttons and reads well in dark mode.
 */
export function Select<T extends string>({ value, onChange, options, label, class: cls = '', icon, compact }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  /** Accessible name — always required, even when there is no visible label. */
  label: string;
  class?: string;
  icon?: ComponentChildren;
  compact?: boolean;
}) {
  return (
    <label class={`relative inline-flex min-w-0 items-center ${cls}`}>
      <span class="sr-only">{label}</span>
      {icon && <span class="pointer-events-none absolute left-3 text-slate-400">{icon}</span>}
      <select
        class={`w-full min-w-0 cursor-pointer appearance-none truncate rounded-xl border border-line bg-surface text-ink transition outline-none hover:border-ocean-500 focus:border-ocean-500 focus:ring-2 focus:ring-ocean-100 ${compact ? 'min-h-11 py-1 text-xs' : 'min-h-11 py-2 text-base sm:text-sm'} ${icon ? 'pl-9' : 'pl-3'} pr-9 font-medium`}
        value={value} onChange={(e) => onChange(e.currentTarget.value as T)}
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <ChevronDown class="pointer-events-none absolute right-3 size-4 text-slate-400" />
    </label>
  );
}

/** Search box with the magnifier and a clear button — the left half of every toolbar. */
export function SearchInput({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label: string }) {
  return (
    <div class="relative min-w-0 flex-1">
      <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
      <input type="search" class="input pr-9 pl-9" value={value} placeholder={placeholder} aria-label={label} onInput={(e) => onChange(e.currentTarget.value)} />
      {value && (
        <button class="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-1 text-slate-400 hover:bg-subtle" onClick={() => onChange('')} aria-label={t('Clear search')}>
          <X class="size-4" />
        </button>
      )}
    </div>
  );
}

/**
 * The filter button that sits beside a search box on every list screen: a badge with the number of
 * filters in use, a sheet from the bottom on phones and a popover under the button on laptops.
 */
export function FilterPopover({ label, count, onClear, children }: {
  /** Names the panel, e.g. “Filter companies”. */
  label: string;
  count: number;
  onClear: () => void;
  children: ComponentChildren;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

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
        class={`btn relative border px-3 ${count ? 'border-ocean-600 bg-ocean-50 text-ocean-700' : 'border-line bg-surface text-ink hover:border-ocean-500 hover:text-ocean-700'}`}
        onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog" aria-label={label}
      >
        <SlidersHorizontal class="size-4" />
        <span class="hidden sm:inline">{t('Filter')}</span>
        {count > 0 && <span class="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-ocean-600 text-[11px] font-bold text-white">{count}</span>}
      </button>

      {open && <div class="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm sm:hidden" onClick={() => setOpen(false)} />}
      {open && (
        <div class="fixed inset-x-0 bottom-0 z-40 max-h-[80dvh] overflow-y-auto rounded-t-3xl border border-line bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl sm:absolute sm:inset-x-auto sm:top-full sm:right-0 sm:bottom-auto sm:mt-2 sm:max-h-[70vh] sm:w-[340px] sm:rounded-2xl sm:pb-4"
          role="dialog" aria-label={label}>
          <div class="mb-3 flex items-center justify-between">
            <p class="text-sm font-bold">{label}</p>
            <button class="inline-flex min-h-11 items-center text-xs font-semibold text-ocean-700 hover:underline disabled:opacity-40" disabled={!count} onClick={onClear}>{t('Clear all')}</button>
          </div>
          <div class="space-y-4">{children}</div>
          <button class="btn-secondary mt-4 w-full" onClick={() => setOpen(false)}>{t('Show results')}</button>
        </div>
      )}
    </div>
  );
}

/** A tick-style choice inside a filter panel. */
export function FilterChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ComponentChildren }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      class={`chip ${on ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line bg-surface text-muted hover:border-ocean-500'}`}>
      {children}
    </button>
  );
}
