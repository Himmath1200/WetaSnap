import { Plus, Tag as TagIcon, X } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { TAG_META } from '../lib/leads';
import { t } from '../lib/i18n';
import type { Tag } from '../lib/types';

/** Tag chips on a lead: staff pick them while scanning, admins filter by them. */
export function TagPicker({ tags, selected, onChange, onCreate }: {
  tags: Tag[];
  selected: string[];
  onChange: (ids: string[]) => void;
  /** Client Admin only: create a tag without leaving the screen. */
  onCreate?: (name: string) => Promise<Tag>;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  async function create() {
    if (!name.trim() || !onCreate) return;
    setBusy(true);
    try {
      const tag = await onCreate(name.trim());
      onChange([...selected, tag.id]);
      setName('');
      setAdding(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <span class="label"><TagIcon class="mr-1 inline size-3.5" />{t('Tags')}</span>
      <div class="flex flex-wrap gap-2">
        {tags.map((g) => {
          const on = selected.includes(g.id);
          return (
            <button key={g.id} type="button" aria-pressed={on} onClick={() => toggle(g.id)}
              class={`chip ${on ? TAG_META[g.colour].chip : 'border-line bg-surface text-slate-600'}`}>
              <span class={`size-2 rounded-full ${TAG_META[g.colour].dot}`} />{g.name}
            </button>
          );
        })}
        {onCreate && !adding && (
          <button type="button" class="chip border-dashed border-line text-muted hover:text-ocean-700" onClick={() => setAdding(true)}>
            <Plus class="size-3.5" />{t('New tag')}
          </button>
        )}
        {adding && (
          <span class="flex items-center gap-1">
            <input class="input min-h-9 w-36 px-2 py-1 text-sm" autoFocus value={name} placeholder={t('Tag name')}
              onInput={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') void create(); if (e.key === 'Escape') setAdding(false); }} />
            <button class="btn-secondary min-h-9 px-2" disabled={busy || !name.trim()} onClick={() => void create()}>{t('Add')}</button>
            <button class="btn-ghost min-h-9 px-1.5" onClick={() => { setAdding(false); setName(''); }} aria-label={t('Cancel')}><X class="size-4" /></button>
          </span>
        )}
        {tags.length === 0 && !onCreate && <span class="text-xs text-muted">{t('No tags yet — an admin can add them in Settings.')}</span>}
      </div>
    </div>
  );
}

export function TagChips({ ids, tags, class: cls = '' }: { ids: string[]; tags: Tag[]; class?: string }) {
  const list = (ids ?? []).map((id) => tags.find((t) => t.id === id)).filter(Boolean) as Tag[];
  if (!list.length) return null;
  return (
    <span class={`inline-flex flex-wrap items-center gap-1 ${cls}`}>
      {list.map((g) => (
        <span key={g.id} class={`pill border ${TAG_META[g.colour].chip}`}>
          <span class={`size-1.5 rounded-full ${TAG_META[g.colour].dot}`} />{g.name}
        </span>
      ))}
    </span>
  );
}
