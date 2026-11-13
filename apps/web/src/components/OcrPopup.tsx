import { useEffect, useState } from 'preact/hooks';
import { Copy, ScanText, X } from 'lucide-preact';
import { subscribeOcrLog, type OcrLogEntry } from '../lib/ocrLog';
import { t } from '../lib/i18n';

/**
 * OCR-LOG: live non-blocking popup with the raw text the scanner read.
 * Appears bottom-right after each scan, auto-hides so it never blocks saving.
 */
export function OcrPopup() {
  const [entry, setEntry] = useState<OcrLogEntry | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => subscribeOcrLog((e) => {
    setEntry(e);
    setOpen(true);
    setCopied(false);
    setExpanded(false);
  }), []);

  // Auto-hide the popup so the review form is never stuck behind it.
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => setOpen(false), 12000);
    return () => clearTimeout(id);
  }, [open, entry?.id]);

  if (!entry || !open) return null;
  const text = (entry.text ?? '').trim();
  const preview = text.length > 220 && !expanded ? `${text.slice(0, 220)}…` : text;

  async function copy() {
    try {
      await navigator.clipboard.writeText(entry!.text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = entry!.text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      class="fixed right-3 bottom-20 z-50 w-[min(92vw,380px)] sm:right-5 sm:bottom-5"
      role="status"
      aria-live="polite"
      aria-label={t('Raw OCR text')}
    >
      <div class="overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
        <header class="flex items-center gap-2 px-3 py-2 border-b border-line">
          <span class="flex size-7 shrink-0 items-center justify-center rounded-lg bg-ocean-100 text-ocean-700">
            <ScanText class="size-4" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="truncate text-xs font-bold">{t('What the scanner read')}</p>
            <p class="truncate text-[11px] text-muted">{entry.source}</p>
          </div>
          <button class="flex size-11 items-center justify-center rounded-lg hover:bg-subtle" onClick={copy} aria-label={t('Copy raw text')}>
            <Copy class="size-4" />
          </button>
          <button class="flex size-11 items-center justify-center rounded-lg hover:bg-subtle" onClick={() => setOpen(false)} aria-label={t('Close')}>
            <X class="size-4" />
          </button>
        </header>
        <div class="max-h-44 overflow-y-auto px-3 pb-2">
          {text ? (
            <button class="w-full rounded-xl bg-subtle p-2.5 text-left font-mono text-[11px] whitespace-pre-wrap break-words text-ink" onClick={() => setExpanded((v) => !v)} title={t('Tap to expand')}>
              {preview}
            </button>
          ) : (
            <p class="rounded-xl bg-subtle p-2.5 text-xs text-muted">{t('Nothing readable on this photo — try better light or move closer.')}</p>
          )}
          <div class="mt-1 flex items-center justify-between">
            <span class="text-[11px] text-muted">
              {new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              {copied ? ` · ${t('Copied')}` : ''}
              {text.length > 220 && !expanded ? ` · ${t('Tap to expand')}` : ''}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
