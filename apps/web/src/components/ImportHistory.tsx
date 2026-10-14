import { useEffect, useState } from 'preact/hooks';
import { ChevronRight, FileUp } from 'lucide-preact';
import { Empty, Sheet, Spinner } from './ui';
import { TagChips } from './TagPicker';
import { backend } from '../lib/backend';
import { timeAgo } from '../lib/id';
import { t, tn } from '../lib/i18n';
import type { ImportBatch, Tag } from '../lib/types';

interface Props {
  open: boolean;
  onClose: () => void;
  tags: Tag[];
  /** Opens the leads list filtered to that import's event and tags. */
  onView: (b: ImportBatch) => void;
}

/** Past Excel/CSV imports, newest first — what each file brought in, and a way back to those leads. */
export function ImportHistory({ open, onClose, tags, onView }: Props) {
  const [rows, setRows] = useState<ImportBatch[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    let live = true;
    setRows(null); setError('');
    void (async () => {
      try {
        const list = await (await backend()).importHistory();
        if (live) setRows([...list].sort((a, b) => b.at.localeCompare(a.at)));
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    })();
    return () => { live = false; };
  }, [open]);

  return (
    <Sheet open={open} onClose={onClose} title={t('Import history')}>
      {error && <p class="mb-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">{error}</p>}
      {rows === null && !error ? (
        <div class="flex justify-center py-12"><Spinner class="size-6 text-brand-700" /></div>
      ) : !rows?.length ? (
        <Empty
          icon={<FileUp class="size-6" />}
          title={t('No imports yet')}
          text={t('Every Excel or CSV file you import appears here, with how many leads it added and which tags it gave them.')}
        />
      ) : (
        <ul class="divide-y divide-line">
          {rows.map((b) => (
            <li key={b.id}>
              <button
                class="flex min-h-11 w-full items-center gap-3 rounded-xl px-2 py-3 text-left transition hover:bg-subtle"
                onClick={() => onView(b)} title={t('View imported leads')}
              >
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm font-semibold">{b.file_name}</span>
                  <span class="block truncate text-xs text-muted">
                    {[b.event_name, b.by, timeAgo(b.at)].filter(Boolean).join(' · ')}
                  </span>
                  <span class="mt-1 flex flex-wrap items-center gap-1.5">
                    <span class="pill bg-brand-100 text-brand-800">{tn(b.imported, '{n} imported', '{n} imported')}</span>
                    {b.skipped > 0 && <span class="pill bg-amber-100 text-amber-800">{tn(b.skipped, '{n} skipped', '{n} skipped')}</span>}
                    <TagChips ids={b.tag_ids} tags={tags} />
                  </span>
                </span>
                <ChevronRight class="size-4 shrink-0 text-muted" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
