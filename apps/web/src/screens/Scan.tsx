import { useEffect, useRef, useState } from 'preact/hooks';
import { Camera as CameraIcon, Keyboard, Upload, Images, ArrowLeft, RotateCcw, Share2, UserPlus, X } from 'lucide-preact';
import { Camera, type CameraHandle } from '../components/Camera';
import { CropCard } from '../components/CropCard';
import { LeadForm, ReadBadge, draftErrors, type Draft, type ReadState } from '../components/LeadForm';
import { TagPicker } from '../components/TagPicker';
import { Spinner } from '../components/ui';
import { useStore, toast } from '../lib/store';
import { config, session } from '../lib/session';
import { saveLocal } from '../lib/sync';
import { compressCard } from '../lib/image';
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

/** S2 · Scan (staff home) + S3 · Review & save. Phone: one column; laptop: webcam left, review right (§5.5). */
export default function Scan() {
  const s = useStore(session)!;
  const cfg = useStore(config);
  const [mode, setMode] = useState<'camera' | 'review'>('camera');
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [thumb, setThumb] = useState<string | null>(null);
  const [backPhoto, setBackPhoto] = useState<Blob | null>(null);
  const [backThumb, setBackThumb] = useState<string | null>(null);
  /** When true the next capture is the back of the card (SCAN-05). */
  const [capturingBack, setCapturingBack] = useState(false);
  const [tags, setTags] = useState<Tag[]>([]);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [source, setSource] = useState<LeadSource>('camera');
  const [read, setRead] = useState<ReadState>('idle');
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dup, setDup] = useState<string | null>(null);
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  /** The photo waiting on the Crop / adjust screen, before anything is read from it. */
  const [cropping, setCropping] = useState<{ blob: Blob; source: LeadSource; back: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const cam = useRef<CameraHandle | null>(null);
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
      // This device first (works offline), then colleagues' captures on the server.
      const local = await db.leads.where('event_id').equals(s.event_id ?? '').filter((l) =>
        (!!email && l.fields.email?.value?.trim().toLowerCase() === email) || (!!phone && phone.length > 6 && l.fields.phone?.value?.replace(/\D/g, '') === phone)).first();
      let at = local?.created_at ?? null;
      if (!at && isOnline() && s.event_id) at = await (await backend()).leadExists(s.event_id, email ?? '', phone ?? '').catch(() => null);
      setDup(at ? t('This visitor was already captured at this event ({time}). You can still save.', { time: new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }) : null);
    }, 300);
    return () => clearTimeout(h);
  }, [draft.fields.email?.value, draft.fields.phone?.value, s.event_id]);

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
        // The company's own OCR service (Surya/Tesseract) — no cloud, no cost.
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
          // The cloud reader is unavailable (not set up, offline mid-request, rate limited):
          // read the card here rather than handing back an empty form.
          if ((err as { code?: string }).code === 'scan_limit') throw err;
        }
      }
      {
        // Offline, or the company has cloud reading switched off: read it here on the device.
        // The language data downloads once (a few MB) and is then kept by the browser.
        setRead('reading');
        const r = await readOffline(blob, s.company?.default_language ?? 'en');
        if (token !== readToken.current) return;
        fillFromRead(r, 'offline');
        setRead('offline');
      }
    } catch (err) {
      if (token !== readToken.current) return;
      setRead('pending');
      // D-9: the month's allowance is used up and the company is set to “block” — say so; typing still works.
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

  async function onCapture(video: HTMLVideoElement, crop: { x: number; y: number; w: number; h: number }) {
    const blob = await compressCard(video, crop);
    if (mode === 'review' && !capturingBack && window.innerWidth < 768) return;
    // SCAN-02: the photo is shown for a crop before anything is read from it.
    setCropping({ blob, source: 'camera', back: capturingBack });
  }

  /** What the Crop / adjust screen hands back: the card alone, ready to read. */
  async function onCropped(blob: Blob) {
    const step = cropping;
    setCropping(null);
    if (!step) return;
    if (step.back) { addBack(blob); return; }
    await startReview(blob, step.source);
  }

  function addBack(blob: Blob) {
    setBackPhoto(blob);
    setBackThumb(URL.createObjectURL(blob));
    setCapturingBack(false);
    setMode('review');
    toast(t('Back of the card added'), 'success', 1500);
  }

  async function onFiles(files: FileList | File[]) {
    const list = [...files].filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    if (list.length === 1) {
      setCropping({ blob: await compressCard(list[0]!), source: 'upload', back: capturingBack });
      return;
    }
    // Many photos → one lead each; AI fills them after sync (SCAN-03).
    if (!s.event_id) { toast(t('Choose an event first.'), 'error'); return; }
    setBatch({ done: 0, total: list.length });
    for (const [i, f] of list.entries()) {
      const blob = await compressCard(f);
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
    // Offline without a reading: allow saving the photo alone, AI fills later (W3 step 2).
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
      if (e.key === ' ' && !typing && mode === 'review' && window.innerWidth >= 768) { e.preventDefault(); cam.current?.capture(); }
      if (e.key === 'Enter' && mode === 'review' && el.tagName !== 'TEXTAREA' && !(el.tagName === 'BUTTON')) { e.preventDefault(); void save(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  /** A lead-shaped object for the contact helpers while the draft is still on screen. */
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
        <LeadForm defs={defs} draft={draft} onChange={setDraft} company={s.company} showErrors={showErrors} readState={read} duplicate={dup} idPrefix="scan" />
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
      <p class="mt-1 max-w-xs text-sm text-muted">{t('Hold the card in the frame, press Space, or drop card photos here.')}</p>
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
      {cropping && (
        <CropCard photo={cropping.blob} onCancel={() => { setCropping(null); setCapturingBack(false); }}
          onDone={(blob) => void onCropped(blob)} />
      )}
      <section class={`relative flex min-h-0 flex-1 flex-col ${mode === 'review' ? 'hidden lg:flex' : 'flex'}`}>
        {!event && <div class="bg-amber-100 px-4 py-2 text-center text-xs font-semibold text-amber-900">{t('No event selected — tap the event name at the top.')}</div>}
        {capturingBack && (
          <div class="flex items-center justify-between gap-2 bg-ocean-600 px-4 py-2 text-xs font-semibold text-white">
            <span>{t('Now hold the back of the card in the frame')}</span>
            <button class="rounded-full bg-black/20 px-2 py-1" onClick={() => { setCapturingBack(false); setMode('review'); }}>{t('Cancel')}</button>
          </div>
        )}
        <div class="relative min-h-0 flex-1"><Camera active handle={(h) => { cam.current = h; }} onCapture={onCapture} /></div>
        <div class="flex items-center justify-around gap-4 bg-surface px-6 py-4 lg:bg-subtle">
          <button class="flex w-16 flex-col items-center gap-1 text-xs font-semibold text-slate-600 hover:text-ocean-700" onClick={() => fileInput.current?.click()}>
            <span class="flex size-12 items-center justify-center rounded-full border border-line bg-surface"><Upload class="size-5" /></span>{t('Upload')}
          </button>
          <button class="group flex size-18 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-ocean-600 p-1 shadow-lg" onClick={() => cam.current?.capture()} aria-label={t('Capture')}>
            <span class="size-full rounded-full border-4 border-white bg-brand-700 transition group-active:scale-90" />
          </button>
          <button class="flex w-16 flex-col items-center gap-1 text-xs font-semibold text-slate-600 hover:text-ocean-700" onClick={() => void startReview(null, 'manual')}>
            <span class="flex size-12 items-center justify-center rounded-full border border-line bg-surface"><Keyboard class="size-5" /></span>{t('Type')}
          </button>
        </div>
        <input ref={fileInput} type="file" accept="image/*" multiple class="hidden" onChange={(e) => { const f = e.currentTarget.files; if (f) void onFiles(f); e.currentTarget.value = ''; }} />
      </section>

      {/* Review side */}
      <section class={`min-h-0 border-line bg-surface lg:flex lg:w-[440px] lg:flex-col lg:border-l xl:w-[500px] ${mode === 'review' ? 'flex flex-1 flex-col lg:flex-none' : 'hidden'}`}>
        {mode === 'review' ? reviewPanel : reviewEmpty}
      </section>

      {(dragging || batch) && (
        <div class="pointer-events-none absolute inset-3 z-10 flex flex-col items-center justify-center rounded-3xl border-4 border-dashed border-ocean-500 bg-ocean-50/90 text-ocean-800">
          <Images class="size-10" />
          <p class="mt-2 font-bold">{batch ? t('Saving {done} of {total}…', batch) : t('Drop card photos — each photo becomes a lead')}</p>
        </div>
      )}
    </div>
  );
}
