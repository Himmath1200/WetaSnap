import { AlertTriangle, Sparkles, Layers, BarChart3, MoreHorizontal, Flame, Sun, Snowflake } from 'lucide-preact';
import { fieldError, normalisePhone, normaliseUrl } from '../lib/validate';
import { t } from '../lib/i18n';
import { Field, Spinner } from './ui';
import type { Company, FieldDefinition, FieldValue, Interest } from '../lib/types';

export interface Draft {
  fields: Record<string, FieldValue>;
  interest: Interest | null;
  leadRating?: 'hot' | 'warm' | 'cold' | null;
  otherInterestText?: string;
  notes: string;
  consent: boolean;
}

export type ReadState = 'idle' | 'reading' | 'ai' | 'offline' | 'pending';

interface Props {
  defs: FieldDefinition[];
  draft: Draft;
  onChange: (d: Draft) => void;
  company: Company | null;
  showErrors: boolean;
  readState?: ReadState;
  duplicate?: string | null;
  crmError?: string | null;
  idPrefix?: string;
}

const PRODUCTS: { id: Interest; label: string; icon: typeof Layers; on: string }[] = [
  { id: 'wetaloop', label: 'WeTaLoop', icon: Layers, on: 'border-brand-500 bg-brand-50 text-brand-700 font-bold' },
  { id: 'wetanalytics', label: 'WeTaAnalytics', icon: BarChart3, on: 'border-ocean-500 bg-ocean-50 text-ocean-700 font-bold' },
  { id: 'other', label: 'Other', icon: MoreHorizontal, on: 'border-amber-500 bg-amber-50 text-amber-800 font-bold' },
];

const RATINGS: { id: 'hot' | 'warm' | 'cold'; label: string; icon: typeof Flame; on: string }[] = [
  { id: 'hot', label: 'Hot', icon: Flame, on: 'border-red-500 bg-red-500/15 text-red-600 font-bold ring-2 ring-red-400' },
  { id: 'warm', label: 'Warm', icon: Sun, on: 'border-amber-500 bg-amber-500/15 text-amber-700 font-bold ring-2 ring-amber-400' },
  { id: 'cold', label: 'Cold', icon: Snowflake, on: 'border-sky-500 bg-sky-500/15 text-sky-600 font-bold ring-2 ring-sky-400' },
];

/** S3 · Review & save form — the company's own fields in its chosen order (AI-02, LEAD-01). */
export function LeadForm({ defs, draft, onChange, company, showErrors, readState = 'idle', duplicate, crmError, idPrefix = 'f' }: Props) {
  const setField = (key: string, value: string) =>
    onChange({ ...draft, fields: { ...draft.fields, [key]: { value, by: 'person' } } }); // AI-04: typed by a person

  // Normalise on blur (AI-08).
  async function tidy(d: FieldDefinition) {
    const cur = draft.fields[d.key];
    if (!cur?.value) return;
    let v: string | null = cur.value;
    if (d.type === 'phone') v = await normalisePhone(cur.value, countryHint(draft));
    if (d.type === 'link') v = normaliseUrl(cur.value);
    if (d.type === 'email') v = cur.value.trim().toLowerCase();
    if (v && v !== cur.value) onChange({ ...draft, fields: { ...draft.fields, [d.key]: { ...cur, value: v } } });
  }

  return (
    <div class="space-y-4">
      {crmError && (
        <div class="flex gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">
          <AlertTriangle class="mt-0.5 size-4 shrink-0" /><span>{crmError}</span>
        </div>
      )}
      {readState === 'reading' && (
        <div class="flex items-center gap-2 rounded-xl bg-ocean-50 px-3 py-2 text-sm font-medium text-ocean-800"><Spinner class="size-4" />{t('Reading the card…')}</div>
      )}
      {readState === 'pending' && (
        <div class="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">{t('Offline — the photo is saved. AI will fill empty fields when you are back online. You can type the name or just save.')}</div>
      )}
      {duplicate && (
        <div class="flex gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900"><AlertTriangle class="mt-0.5 size-4 shrink-0" /><span>{duplicate}</span></div>
      )}

      <div class="grid gap-3 sm:grid-cols-2">
        {defs.map((d) => {
          const fv = draft.fields[d.key];
          const value = fv?.value ?? '';
          const uncertain = fv && fv.by !== 'person' && (fv.confidence ?? 1) < 0.8 && value;
          const err = showErrors ? fieldError(d.type, value, d.required) : null;
          const id = `${idPrefix}-${d.key}`;
          const cls = `input ${uncertain ? 'input-warn' : ''} ${err ? '!border-red-400' : ''}`;
          const wide = d.type === 'longtext' || d.type === 'choice';
          return (
            <div key={d.id} class={wide ? 'sm:col-span-2' : ''}>
              <Field for={id} label={`${d.label}${d.required ? ' *' : ''}`} error={err ? t(err) : null} warn={uncertain ? fv.reason ?? t('Please check this value') : null}>
                {d.type === 'longtext' ? (
                  <textarea id={id} rows={3} class={cls} value={value} onInput={(e) => setField(d.key, e.currentTarget.value)} />
                ) : d.type === 'choice' ? (
                  <div class="flex flex-wrap gap-2">
                    {d.options.map((o) => (
                      <button key={o} type="button" aria-pressed={value === o} onClick={() => setField(d.key, value === o ? '' : o)}
                        class={`chip ${value === o ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line bg-surface text-slate-700'}`}>{o}</button>
                    ))}
                  </div>
                ) : (
                  <input id={id} class={cls} value={value}
                    type={d.type === 'email' ? 'email' : d.type === 'phone' ? 'tel' : d.type === 'link' ? 'url' : 'text'}
                    inputMode={d.type === 'email' ? 'email' : d.type === 'phone' ? 'tel' : d.type === 'link' ? 'url' : 'text'}
                    autoCapitalize={d.type === 'text' ? 'words' : 'off'}
                    onInput={(e) => setField(d.key, e.currentTarget.value)} onBlur={() => void tidy(d)} />
                )}
              </Field>
            </div>
          );
        })}
      </div>

      <div>
        <span class="label">{t('Product Interest')}</span>
        <div class="flex gap-2">
          {PRODUCTS.map((i) => (
            <button key={i.id} type="button" aria-pressed={draft.interest === i.id} onClick={() => onChange({ ...draft, interest: draft.interest === i.id ? null : i.id })}
              class={`chip flex-1 justify-center py-2 text-xs transition ${draft.interest === i.id ? i.on : 'border-line bg-surface text-slate-600'}`}>
              <i.icon class="size-4" />{t(i.label)}
            </button>
          ))}
        </div>
        {draft.interest === 'other' && (
          <div class="mt-2.5">
            <input
              type="text"
              class="input text-xs"
              placeholder={t('Specify other product / service of interest...')}
              value={draft.otherInterestText ?? ''}
              onInput={(e) => onChange({ ...draft, otherInterestText: e.currentTarget.value })}
              autoFocus
            />
          </div>
        )}
      </div>

      <div>
        <span class="label">{t('Lead Priority Indicator')}</span>
        <div class="flex gap-2">
          {RATINGS.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-pressed={draft.leadRating === r.id}
              onClick={() => onChange({ ...draft, leadRating: draft.leadRating === r.id ? null : r.id })}
              class={`chip flex-1 justify-center py-2 text-xs transition ${draft.leadRating === r.id ? r.on : 'border-line bg-surface text-slate-600'}`}
            >
              <r.icon class="size-4" />
              <span>{t(r.label)}</span>
            </button>
          ))}
        </div>
      </div>

      <label class="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface p-3">
        <input type="checkbox" class="mt-0.5 size-5 shrink-0 accent-brand-700" checked={draft.consent} onChange={(e) => onChange({ ...draft, consent: e.currentTarget.checked })} />
        <span class="text-sm text-slate-700">{company?.consent_text ?? t('The visitor agrees to be contacted.')}</span>
      </label>
    </div>
  );
}

export function ReadBadge({ state }: { state: ReadState }) {
  if (state === 'ai') return <span class="pill bg-ocean-50 text-ocean-700"><Sparkles class="size-3.5" />{t('Read by AI')}</span>;
  if (state === 'offline') return <span class="pill bg-brand-50 text-brand-700">{t('Read on device')}</span>;
  return null;
}

/** Required fields filled and values valid? */
export function draftErrors(defs: FieldDefinition[], d: Draft) {
  return defs.filter((f) => fieldError(f.type, d.fields[f.key]?.value ?? '', f.required)).map((f) => f.label);
}

function countryHint(d: Draft) {
  const c = (d.fields.country?.value ?? '').toLowerCase();
  const map: Record<string, string> = { germany: 'DE', deutschland: 'DE', france: 'FR', italy: 'IT', italia: 'IT', spain: 'ES', españa: 'ES', netherlands: 'NL', nederland: 'NL', portugal: 'PT', 'united kingdom': 'GB', uk: 'GB', india: 'IN', austria: 'AT', switzerland: 'CH', belgium: 'BE' };
  return map[c] ?? 'DE';
}
