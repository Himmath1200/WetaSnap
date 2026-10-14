import { useEffect, useMemo, useState } from 'preact/hooks';
import { ArrowLeft, Download, FileSpreadsheet, Upload, TriangleAlert, CheckCircle2 } from 'lucide-preact';
import { Field, Sheet, Spinner } from './ui';
import { TagPicker } from './TagPicker';
import { backend, type ImportRow } from '../lib/backend';
import { guessMapping, importTemplateXlsx, readSpreadsheet, type Sheet as SheetData } from '../lib/xlsx';
import { useStore, toast } from '../lib/store';
import { config } from '../lib/session';
import { t, tn } from '../lib/i18n';
import { reportError } from '../lib/errors';
import { emptyFilters, type Lead, type Tag } from '../lib/types';

type Step = 'file' | 'map' | 'done';

/** Import leads from Excel or CSV: pick a file, match the columns, check, import (ADM-08). */
export function ImportLeads({ open, onClose, tags, onImported }: {
  open: boolean;
  onClose: () => void;
  tags: Tag[];
  onImported: () => void;
}) {
  const cfg = useStore(config);
  const defs = cfg.fields;
  const [step, setStep] = useState<Step>('file');
  const [sheet, setSheet] = useState<SheetData | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [eventId, setEventId] = useState(cfg.events.find((e) => e.status === 'open')?.id ?? '');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ imported: number; skipped: number } | null>(null);
  const [fileName, setFileName] = useState('');
  // D-12: duplicates are checked against every lead of the company at the chosen event,
  // not only the rows the Leads screen happens to show under its current filters.
  const [existing, setExisting] = useState<Lead[]>([]);
  useEffect(() => {
    if (!open || !eventId) { setExisting([]); return; }
    let live = true;
    void backend().then((b) => b.listLeads({ ...emptyFilters(), event_ids: [eventId] }))
      .then((l) => { if (live) setExisting(l); })
      .catch((e) => { if (live) { setExisting([]); void reportError(e, { action: 'Check import for duplicates', where: 'ImportLeads › listLeads' }); } });
    return () => { live = false; };
  }, [open, eventId]);

  function reset() {
    setStep('file'); setSheet(null); setMapping({}); setResult(null); setFileName(''); setTagIds([]);
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const data = await readSpreadsheet(file);
      if (!data.headers.length || !data.rows.length) throw new Error(t('That file has no rows to import.'));
      setSheet(data);
      setFileName(file.name);
      setMapping(guessMapping(data.headers, defs));
      setStep('map');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  // Build the rows, flagging duplicates by email/phone against this event's existing leads.
  const rows = useMemo<ImportRow[]>(() => {
    if (!sheet) return [];
    const seen = new Map<string, true>();
    for (const l of existing.filter((l) => l.event_id === eventId)) {
      const e = l.fields.email?.value?.trim().toLowerCase();
      const p = l.fields.phone?.value?.replace(/\D/g, '');
      if (e) seen.set('e:' + e, true);
      if (p && p.length > 6) seen.set('p:' + p, true);
    }
    return sheet.rows.map((r) => {
      const fields: Record<string, string> = {};
      for (const [key, header] of Object.entries(mapping)) {
        const i = sheet.headers.indexOf(header);
        if (i >= 0) fields[key] = (r[i] ?? '').trim();
      }
      const e = fields.email?.trim().toLowerCase();
      const p = fields.phone?.replace(/\D/g, '');
      const dupInFile = (e && seen.has('e:' + e)) || (p && p.length > 6 && seen.has('p:' + p));
      if (e) seen.set('e:' + e, true);
      if (p && p.length > 6) seen.set('p:' + p, true);
      return { fields, duplicate: Boolean(dupInFile) };
    });
  }, [sheet, mapping, existing, eventId]);

  const mapped = Object.values(mapping).filter(Boolean).length;
  const dupes = rows.filter((r) => r.duplicate).length;
  const missingRequired = defs.filter((d) => d.required && !mapping[d.key]);

  async function run() {
    if (!eventId) { toast(t('Choose the event these leads belong to.'), 'error'); return; }
    if (missingRequired.length) { toast(t('Match these first: {fields}', { fields: missingRequired.map((d) => d.label).join(', ') }), 'error'); return; }
    setBusy(true);
    try {
      const r = await (await backend()).importLeads(rows, eventId, tagIds, fileName);
      setResult(r);
      setStep('done');
      onImported();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function downloadTemplate() {
    const blob = await importTemplateXlsx(defs);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'wetasnap-import-template.xlsx';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  return (
    <Sheet
      open={open} onClose={() => { onClose(); reset(); }} wide
      title={t('Import leads')}
      footer={
        step === 'map' ? (
          <>
            <button class="btn-ghost" onClick={reset}><ArrowLeft class="size-4" />{t('Back')}</button>
            <button class="btn-primary ml-auto min-w-40" disabled={busy || !rows.length} onClick={() => void run()}>
              {busy ? <Spinner /> : tn(rows.length - dupes, 'Import {n} lead', 'Import {n} leads')}
            </button>
          </>
        ) : step === 'done' ? (
          <button class="btn-primary ml-auto" onClick={() => { onClose(); reset(); }}>{t('Done')}</button>
        ) : (
          <button class="btn-secondary ml-auto" onClick={() => void downloadTemplate()}><Download class="size-4" />{t('Download template')}</button>
        )
      }
    >
      {step === 'file' && (
        <div class="space-y-4">
          <p class="text-sm text-muted">{t('Bring in leads collected elsewhere — an old scanner, a spreadsheet from a colleague, or a list from the organiser.')}</p>
          <label class="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-ocean-200 bg-ocean-50/40 px-6 py-10 text-center transition hover:border-ocean-500">
            {busy ? <Spinner class="size-6 text-ocean-700" /> : <Upload class="size-7 text-ocean-700" />}
            <span class="text-sm font-semibold">{t('Choose an Excel or CSV file')}</span>
            <span class="text-xs text-muted">{t('.xlsx, .xls or .csv — the first row must be the column names')}</span>
            <input type="file" class="hidden" accept=".xlsx,.xls,.csv,text/csv" onChange={(e) => void onFile(e.currentTarget.files?.[0])} />
          </label>
          <p class="text-xs text-muted">{t('Not sure about the columns? Download the template, fill it in and import it back.')}</p>
        </div>
      )}

      {step === 'map' && sheet && (
        <div class="space-y-5">
          <p class="flex items-center gap-2 rounded-xl bg-subtle px-3 py-2 text-sm">
            <FileSpreadsheet class="size-4 shrink-0 text-ocean-700" />
            <span class="min-w-0 flex-1 truncate font-medium">{fileName}</span>
            <span class="shrink-0 text-xs text-muted">{tn(sheet.rows.length, '{n} row', '{n} rows')}</span>
          </p>

          <Field label={t('Event')} for="imp-event" hint={t('Every imported lead is filed under this event.')}>
            <select id="imp-event" class="input" value={eventId} onChange={(e) => setEventId(e.currentTarget.value)}>
              <option value="">{t('Choose an event')}</option>
              {cfg.events.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </Field>

          <TagPicker tags={tags} selected={tagIds} onChange={setTagIds} />

          <section>
            <div class="mb-1 flex items-baseline justify-between">
              <span class="label">{t('Match the columns')}</span>
              <span class="text-xs text-muted">{t('{n} of {total} matched', { n: mapped, total: defs.length })}</span>
            </div>
            <div class="space-y-1.5">
              {defs.map((d) => (
                <div key={d.id} class="flex items-center gap-2">
                  <span class="w-32 shrink-0 truncate text-sm font-medium">{d.label}{d.required && <span class="text-red-700"> *</span>}</span>
                  <select class="input min-h-10 flex-1" value={mapping[d.key] ?? ''} onChange={(e) => setMapping({ ...mapping, [d.key]: e.currentTarget.value })}>
                    <option value="">{t('Do not import')}</option>
                    {sheet.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </section>

          {missingRequired.length > 0 && (
            <p class="flex gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-800">
              <TriangleAlert class="mt-0.5 size-4 shrink-0" />{t('These fields are required: {fields}', { fields: missingRequired.map((d) => d.label).join(', ') })}
            </p>
          )}
          {dupes > 0 && (
            <p class="flex gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <TriangleAlert class="mt-0.5 size-4 shrink-0" />{tn(dupes, '{n} row looks like a lead you already have — it will be skipped.', '{n} rows look like leads you already have — they will be skipped.')}
            </p>
          )}

          <section>
            <span class="label">{t('Preview (first 5 rows)')}</span>
            <div class="overflow-x-auto rounded-xl border border-line">
              <table class="w-full text-xs">
                <thead class="bg-subtle text-left text-muted">
                  <tr>{defs.filter((d) => mapping[d.key]).slice(0, 5).map((d) => <th key={d.id} class="px-2 py-1.5 whitespace-nowrap">{d.label}</th>)}<th class="px-2 py-1.5" /></tr>
                </thead>
                <tbody class="divide-y divide-line">
                  {rows.slice(0, 5).map((r, i) => (
                    <tr key={i} class={r.duplicate ? 'opacity-50' : ''}>
                      {defs.filter((d) => mapping[d.key]).slice(0, 5).map((d) => <td key={d.id} class="max-w-40 truncate px-2 py-1.5">{r.fields[d.key]}</td>)}
                      <td class="px-2 py-1.5">{r.duplicate && <span class="pill bg-amber-100 text-amber-800">{t('Duplicate')}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {step === 'done' && result && (
        <div class="flex flex-col items-center gap-3 py-10 text-center">
          <span class="flex size-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-700"><CheckCircle2 class="size-7" /></span>
          <p class="text-lg font-bold">{tn(result.imported, '{n} lead imported', '{n} leads imported')}</p>
          {result.skipped > 0 && <p class="text-sm text-muted">{tn(result.skipped, '{n} row skipped as a duplicate.', '{n} rows skipped as duplicates.')}</p>}
          <p class="max-w-xs text-sm text-muted">{t('They are in the Leads list now and will be sent to your CRM like any other lead.')}</p>
        </div>
      )}
    </Sheet>
  );
}
