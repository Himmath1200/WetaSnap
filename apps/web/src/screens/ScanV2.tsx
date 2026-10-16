import { useEffect, useRef, useState } from 'preact/hooks';
import { ArrowLeft, Images, Keyboard, ScanSearch, Upload, RotateCcw, Share2, UserPlus, X, Camera as CameraIcon } from 'lucide-preact';
import { DocCamera } from '../components/DocCamera';
import { CornerEditor } from '../components/CornerEditor';
import { LeadForm, ReadBadge, draftErrors, type Draft, type ReadState } from '../components/LeadForm';
import { TagPicker } from '../components/TagPicker';
import { Spinner } from '../components/ui';
import { useStore, toast } from '../lib/store';
import { config, session } from '../lib/session';
import { saveLocal } from '../lib/sync';
import { compressCard } from '../lib/image';
import { extractCard } from '../lib/scanEngine';
import { blobToCanvas, developScan } from '../lib/scanV2';
import type { Quad } from '../lib/scanEngine';
import { backend } from '../lib/backend';
import { isOnline } from '../lib/net';
import { db } from '../lib/db';
import { deviceLabel, nowIso, uuid } from '../lib/id';
import { readOffline } from '../lib/offlineReader';
import { localOcrAvailable, readWithLocalOcr } from '../lib/ocr';
import { ClipboardFallback, saveToPhone, shareContact } from '../lib/contact';
import { t, tn } from '../lib/i18n';
import type { FieldValue, Lead, LeadSource, Tag } from '../lib/types';

const emptyDraft = (): Draft => ({ fields: {}, interest: null, notes: '', consent: false });

interface Adjust { canvas: HTMLCanvasElement; quad: Quad | null; back: boolean }

/**
 * SCAN-V2 · Pro scanner (staff home alternative). The capture path is the only
 * thing that differs from Scan.tsx: live edge detection → corner true-up →
 * perspective warp → the shared clean-up. From the review form on (reading,
 * filling, saving) the two scanners run the exact same code path shape.
 */
export default function ScanV2() {
  const s = useStore(session)!;
  const cfg = useStore(config);
  const [mode, setMode] = useState<'camera' | 'adjust' | 'review'>('camera');
  const [adjust, setAdjust] = useState<Adjust | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [thumb, setThumb] = useState<string | null>(null);
  const [backPhoto, setBackPhoto] = useState<Blob | null>(null);
  const [backThumb, setBackThumb] = useState<string | null>(null);
  /** When true the next shot is the back of the card (SCAN-05). */
  const [capturingBack, setCapturingBack] = useState(false);
  const [tags, setTags] = useState<Tag[]>([]);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [source, setSource] = useState<LeadSource>('camera');
  const [read, setRead] = useState<ReadState>('idle');
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dup, setDup] = useState<string | null>(null);
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const cam = useRef<{ capture: () => void } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const readToken = useRef(0);
  const defs = cfg.fields;
  const event = cfg.events.find((e) => e.id === s.event_id);

  useEffect(() => () => { if (thumb) URL.revokeObjectURL(thumb); }, [thumb]);
  useEffect(() => () => { if (backThumb) URL.revokeObjectURL(backThumb); }, [backThumb]);
  useEffect(() => { void backend().then((b) => b.tags()).then(setTags).catch(() => {}); }, []);

  // LEAD-05: warn (never block) when this email/phone was already captured at this event.
  useEffect(() => {
    const email = draft.fields.email?.value?.trim().toLowerCase();
    const phone = draft.fields.phone?.value?.replace(/\D/g, '');
    if (!email && !phone) { setDup(null); return; }
    const h = setTimeout(async () => {
      const local = await db.leads.where('event_id').equals(s.event_id ?? '').filter((l) =>
        (!!email && l.fields.email?.value?.trim().toLowerCase() === email) || (!!phone && phone.length > 6 && l.fields.phone?.value?.replace(/\D/g, '') === phone)).first();
      let at = local?.created_at ?? null;
      if (!at && isOnline() && s.event_id) at = await (await backend()).leadExists(s.event_id, email ?? '', phone ?? '').catch(() => null);
      setDup(at ? t('This visitor was already captured at this event ({time}). You can still save.', { time: new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }) : null);
    }, 300);
    return () => clearTimeout(h);
  }, [draft.fields.email?.value, draft.fields.phone?.value, s.event_id]);

  /** Same reading chain as the classic scanner: local OCR → cloud → on-device. */
  async function startReview(blob: Blob | null, src: LeadSource) {
    const token = ++readToken.current;
    setPhoto(blob);
    setThumb(blob ? URL.createObjectURL(blob) : null);
    setSource(src);
    setDraft(emptyDraft());
    setShowErrors(false);
    setMode('review');
    if (!blob) { setRead('idle'); return; }

    const aiAllowed = s.company?.cloud_ai_enabled !== false;
    try {
      if (await localOcrAvailable()) {
        setRead('reading');
        try {
          const r = await readWithLocalOcr(blob, defs, s.company?.default_language ?? 'en');
          if (token !== readToken.current) return;
          fillFromRead(r, 'offline');
          setRead('offline');
          return;
        } catch {
          if (!isOnline() || !aiAllowed) throw new Error('local ocr failed');
        }
      }
      if (isOnline() && aiAllowed) {
        setRead('reading');
        try {
          const r = await (await backend()).readCard(blob);
          if (token !== readToken.current) return;
          fillFromRead(r, 'ai');
          setRead('ai');
          return;
        } catch (err) {
          if ((err as { code?: string }).code === 'scan_limit') throw err;
        }
      }
      {
        setRead('reading');
        const r = await readOffline(blob, s.company?.default_language ?? 'en');
        if (token !== readToken.current) return;
        fillFromRead(r, 'offline');
        setRead('offline');
      }
    } catch (err) {
      if (token !== readToken.current) return;
      setRead('pending');
      if ((err as { code?: string }).code === 'scan_limit') toast(t((err as Error).message), 'info', 6000);
    }
  }

  /** Never overwrite what the person already typed while the AI was reading (AI-04). */
  function fillFromRead(r: Record<string, { value: string; confidence: number; reason?: string }>, by: FieldValue['by']) {
    setDraft((d) => {
      const fields = { ...d.fields };
      for (const [k, v] of Object.entries(r)) if (!(fields[k]?.by === 'person' && fields[k]?.value)) fields[k] = { value: v.value, confidence: v.confidence, reason: v.reason, by };
      return { ...d, fields };
    });
  }

  function addBack(blob: Blob) {
    setBackPhoto(blob);
    setBackThumb(URL.createObjectURL(blob));
    setCapturingBack(false);
    setAdjust(null);
    setMode('review');
    toast(t('Back of the card added'), 'success', 1500);
  }

  /** Warped + cleaned scan → the review form (front) or the back slot. */
  async function onAdjustDone(blob: Blob) {
    if (adjust?.back) { addBack(blob); return; }
    setAdjust(null);
    await startReview(blob, 'camera');
  }

  async function onFiles(files: FileList | File[]) {
    const list = [...files].filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    if (list.length === 1) {
      // Single upload → the true-up step first, like a camera shot.
      const canvas = await blobToCanvas(list[0]!);
      setAdjust({ canvas, quad: null, back: capturingBack });
      setMode('adjust');
      return;
    }
    // Many photos → one lead each, auto-warped; AI fills them after sync (SCAN-03).
    if (!s.event_id) { toast(t('Choose an event first.'), 'error'); return; }
    setBatch({ done: 0, total: list.length });
    for (const [i, f] of list.entries()) {
      let blob: Blob;
      try {
        const canvas = await blobToCanvas(f);
        const warped = await extractCard(canvas, canvas.width, canvas.height);
        blob = warped ? await developScan(warped.canvas, 'color') : await compressCard(f);
      } catch {
        blob = await compressCard(f);
      }
      await saveLocal(newLead(emptyDraft(), 'upload'), blob);
      setBatch({ done: i + 1, total: list.length });
    }
    toast(tn(list.length, '{n} lead saved. It will be read after sync.', '{n} leads saved. They will be read after sync.'), 'success');
    setBatch(null);
  }

  function newLead(d: Draft, src: LeadSource): Lead {
    const now = nowIso();
    return {
      id: uuid(), company_id: s.person.company_id!, event_id: s.event_id!, captured_by: s.person.id, captured_by_name: s.person.name,
      device: deviceLabel(), source: src, fields: d.fields, interest: d.interest, notes: d.notes.trim(),
      consent: d.consent, consent_version: s.company?.consent_version ?? 1, consent_at: d.consent ? now : null,
      status: 'waiting', crm_error: null, crm_record_id: null, crm_history: [], has_photo: false, has_back_photo: !!backPhoto,
      tag_ids: tagIds,
      created_at: now, updated_at: now, synced_at: null, deleted_at: null,
    };
  }

  async function save() {
    if (!s.event_id) { toast(t('Choose an event first (tap the event name at the top).'), 'error'); return; }
    const missing = draftErrors(defs, draft);
    const photoOnly = read === 'pending' && photo && Object.values(draft.fields).every((f) => !f.value);
    if (missing.length && !photoOnly) { setShowErrors(true); toast(t('Please check: {fields}', { fields: missing.join(', ') }), 'error'); return; }
    setSaving(true);
    try {
      await saveLocal(newLead(draft, source), photo, backPhoto);
      toast(t('Lead saved'), 'success', 1800);
      readToken.current++;
      setMode('camera'); // next scan ready at once (SCAN-08)
      setDraft(emptyDraft());
      setPhoto(null);
      setThumb(null);
      setBackPhoto(null);
      setBackThumb(null);
      setTagIds([]);
      setRead('idle');
    } finally {
      setSaving(false);
    }
  }

  // Laptop shortcuts: Space = capture, Enter = save (SCAN-09).
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
      if (e.key === ' ' && !typing && mode === 'camera') { e.preventDefault(); cam.current?.capture(); }
      if (e.key === 'Enter' && mode === 'review' && el.tagName !== 'TEXTAREA' && !(el.tagName === 'BUTTON')) { e.preventDefault(); void save(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const draftAsLead = (): Lead => newLead(draft, source);

  async function onShare() {
    try {
      await shareContact(draftAsLead(), defs, event?.name);
    } catch (e) {
      if (e instanceof ClipboardFallback) toast(t('Contact details copied — paste them where you need them.'), 'success');
      else if ((e as Error).name !== 'AbortError') toast(t('Sharing is not available on this device.'), 'error');
    }
  }

  const reviewPanel = (
    <div class="flex h-full flex-col">
      <div class="flex items-center gap-3 border-b border-line px-4 py-3">
        <button class="btn-ghost -ml-2 min-w-11 px-2 lg:hidden" onClick={() => { readToken.current++; setMode('camera'); }} aria-label={t('Back')}><ArrowLeft class="size-5" /></button>
        {thumb ? <img src={thumb} alt={t('Front of the card')} class="card-photo h-12 w-19 rounded-lg border border-line object-cover" /> : <span class="flex h-12 w-19 items-center justify-center rounded-lg bg-slate-100 text-slate-400"><Keyboard class="size-5" /></span>}
        {backThumb && (
          <span class="relative">
            <img src={backThumb} alt={t('Back of the card')} class="card-photo h-12 w-19 rounded-lg border border-line object-cover" />
            <button class="absolute -top-1.5 -right-1.5 rounded-full bg-slate-900/80 p-0.5 text-white" onClick={() => { setBackPhoto(null); setBackThumb(null); }} aria-label={t('Remove the back photo')}><X class="size-3" /></button>
          </span>
        )}
        <div class="min-w-0">
          <p class="text-sm font-bold">{t('Review & save')}</p>
          <ReadBadge state={read} />
        </div>
      </div>
      <div class="flex-1 overflow-y-auto px-4 py-4">
        <div class="mb-4 flex flex-wrap gap-2">
          {!backPhoto && photo && (
            <button class="btn-secondary min-h-10 px-3 text-xs" onClick={() => { setCapturingBack(true); setMode('camera'); }}>
              <RotateCcw class="size-4" />{t('Add the back of the card')}
            </button>
          )}
          <button class="btn-secondary min-h-10 px-3 text-xs" onClick={() => saveToPhone(draftAsLead(), defs, event?.name)}>
            <UserPlus class="size-4" />{t('Save to device')}
          </button>
          <button class="btn-secondary min-h-10 px-3 text-xs" onClick={() => void onShare()}>
            <Share2 class="size-4" />{t('Share contact')}
          </button>
        </div>
        <div class="mb-4"><TagPicker tags={tags} selected={tagIds} onChange={setTagIds} /></div>
        <LeadForm defs={defs} draft={draft} onChange={setDraft} company={s.company} showErrors={showErrors} readState={read} duplicate={dup} idPrefix="scan-v2" />
      </div>
      <div class="flex items-center gap-3 border-t border-line bg-surface px-4 py-3">
        <button class="link tap text-sm" onClick={() => { readToken.current++; setMode('camera'); setPhoto(null); setThumb(null); }}>{t('Retake')}</button>
        <button class="btn-primary ml-auto min-w-40" disabled={saving || read === 'reading'} onClick={() => void save()}>{saving ? <Spinner /> : t('Save lead')}</button>
      </div>
    </div>
  );

  const reviewEmpty = (
    <div class="flex h-full flex-col items-center justify-center p-8 text-center">
      <div class="mb-3 flex size-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-700"><CameraIcon class="size-7" /></div>
      <p class="font-semibold">{t('Scan a card to start')}</p>
      <p class="mt-1 max-w-xs text-sm text-muted">{t('Point at the card until the green outline locks on, then line up the corners.')}</p>
      <div class="mt-4 flex gap-2 text-xs text-muted"><kbd class="rounded border border-line bg-surface px-1.5 py-0.5 font-mono">Space</kbd>{t('capture')}<kbd class="ml-2 rounded border border-line bg-surface px-1.5 py-0.5 font-mono">Enter</kbd>{t('save')}</div>
    </div>
  );

  return (
    <div
      class="relative flex min-h-0 flex-1 flex-col lg:flex-row"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer?.files) void onFiles(e.dataTransfer.files); }}
    >
      {/* Camera side */}
      {mode !== 'adjust' && (
        <section class={`relative flex min-h-0 flex-1 flex-col ${mode === 'review' ? 'hidden lg:flex' : 'flex'}`}>
          {!event && <div class="bg-amber-100 px-4 py-2 text-center text-xs font-semibold text-amber-900">{t('No event selected — tap the event name at the top.')}</div>}
          {capturingBack && (
            <div class="flex items-center justify-between gap-2 bg-ocean-600 px-4 py-2 text-xs font-semibold text-white">
              <span>{t('Now hold the back of the card in the frame')}</span>
              <button class="rounded-full bg-black/20 px-2 py-1" onClick={() => { setCapturingBack(false); }}>{t('Cancel')}</button>
            </div>
          )}
          <div class="relative min-h-0 flex-1">
            <DocCamera active={mode === 'camera'} handle={(h) => { cam.current = h; }} onShot={(shot) => { setAdjust({ canvas: shot.canvas, quad: shot.quad, back: capturingBack }); setMode('adjust'); }} />
          </div>
          <div class="flex items-center justify-around gap-4 bg-surface px-6 py-4 lg:bg-subtle">
            <button class="flex w-16 flex-col items-center gap-1 text-xs font-semibold text-slate-600 hover:text-ocean-700" onClick={() => fileInput.current?.click()}>
              <span class="flex size-12 items-center justify-center rounded-full border border-line bg-surface"><Upload class="size-5" /></span>{t('Upload')}
            </button>
            <button class="group flex size-18 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-ocean-600 p-1 shadow-lg" onClick={() => cam.current?.capture()} aria-label={t('Capture')}>
              <span class="flex size-full items-center justify-center rounded-full border-4 border-white bg-brand-700 transition group-active:scale-90"><ScanSearch class="size-6 text-white" /></span>
            </button>
            <button class="flex w-16 flex-col items-center gap-1 text-xs font-semibold text-slate-600 hover:text-ocean-700" onClick={() => void startReview(null, 'manual')}>
              <span class="flex size-12 items-center justify-center rounded-full border border-line bg-surface"><Keyboard class="size-5" /></span>{t('Type')}
            </button>
          </div>
          <input ref={fileInput} type="file" accept="image/*" multiple class="hidden" onChange={(e) => { const f = e.currentTarget.files; if (f) void onFiles(f); e.currentTarget.value = ''; }} />
        </section>
      )}

      {/* True-up side */}
      {mode === 'adjust' && adjust && (
        <section class="flex min-h-0 flex-1 flex-col bg-surface">
          <CornerEditor
            photo={adjust.canvas}
            initial={adjust.quad}
            onDone={(blob) => void onAdjustDone(blob)}
            onRetake={() => { setAdjust(null); setCapturingBack(false); setMode('camera'); }}
          />
        </section>
      )}

      {/* Review side */}
      {mode === 'review' && (
        <section class="flex min-h-0 flex-1 flex-col border-line bg-surface lg:w-[440px] lg:flex-none lg:border-l xl:w-[500px]">
          {reviewPanel}
        </section>
      )}
      {mode !== 'review' && mode !== 'adjust' && (
        <section class="hidden min-h-0 border-line bg-surface lg:flex lg:w-[440px] lg:flex-col lg:border-l xl:w-[500px]">
          {reviewEmpty}
        </section>
      )}

      {(dragging || batch) && (
        <div class="pointer-events-none absolute inset-3 z-10 flex flex-col items-center justify-center rounded-3xl border-4 border-dashed border-ocean-500 bg-ocean-50/90 text-ocean-800">
          <Images class="size-10" />
          <p class="mt-2 font-bold">{batch ? t('Saving {done} of {total}…', batch) : t('Drop card photos — each photo becomes a lead')}</p>
        </div>
      )}
    </div>
  );
}
