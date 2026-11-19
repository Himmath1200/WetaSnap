import { useEffect, useRef, useState } from 'preact/hooks';
import { ArrowLeft, Images, Keyboard, ScanSearch, Upload, RotateCcw, Share2, UserPlus, X, Camera as CameraIcon, Crown, Zap, Lock, CalendarClock } from 'lucide-preact';
import { DocCamera } from '../components/DocCamera';
import { CornerEditor } from '../components/CornerEditor';
import { LeadForm, ReadBadge, draftErrors, type Draft, type ReadState } from '../components/LeadForm';
import { TagPicker } from '../components/TagPicker';
import { Dialog, Spinner } from '../components/ui';
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
import { geminiAvailable, hasLowConfidenceField, verifyLowConfidenceWithGemini } from '../lib/gemini';
import type { DocShot } from '../components/DocCamera';
import { ClipboardFallback, saveToPhone, shareContact } from '../lib/contact';
import { getFollowUpConfig, formatFollowUpMessage, sendViaWhatsApp, sendViaEmail } from '../lib/followup';
import { FollowUpModal } from '../components/FollowUpModal';
import { linkFor } from '../lib/portal';
import { t, tn } from '../lib/i18n';
import type { FieldValue, Lead, LeadSource, Tag } from '../lib/types';

const emptyDraft = (): Draft => ({ fields: {}, interest: null, notes: '', consent: false });

interface Adjust { canvas: HTMLCanvasElement; quad: Quad | null; back: boolean }

/**
 * SCAN-V2 · Pro scanner (staff home alternative). The capture path is the only
 * thing that differs from Scan.tsx: live corner detection → corner true-up →
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
  const [followUpLead, setFollowUpLead] = useState<Lead | null>(null);
  const [fuModalOpen, setFuModalOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const cam = useRef<{ capture: () => void } | null>(null);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const readToken = useRef(0);
  const defs = cfg.fields;
  const event = cfg.events.find((e) => e.id === s.event_id);

  const isIndividual = s.person.role === 'individual';
  const [activeScans, setActiveScans] = useState(s.person.monthly_scans ?? 0);
  useEffect(() => {
    if (!isIndividual) return;
    void db.leads.filter((l) => !l.deleted_at && l.captured_by === s.person.id).count().then(setActiveScans);
  }, [isIndividual, s.person.id]);

  useEffect(() => {
    if (s.company?.id) {
      void backend().then((b) => b.company()).then((freshCo) => {
        if (freshCo) {
          const cur = session.get();
          if (cur && cur.company) {
            const next = { ...cur, company: { ...cur.company, ...freshCo } };
            session.set(next);
            void db.session.update('current', { company: next.company });
          }
        }
      }).catch(() => {});
    }
  }, [s.company?.id]);
  const isFreeOverLimit = isIndividual && s.person.plan !== 'pro' && activeScans >= 5;

  function eventBlockReason() {
    if (!event || isIndividual) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const start = new Date(event.starts_on); start.setHours(0, 0, 0, 0);
    const end = new Date(event.ends_on); end.setHours(23, 59, 59, 999);
    if (today < start) return t('upcoming');
    if (today > end || event.status === 'closed') return t('ended');
    return null;
  }
  const eventBlocked = eventBlockReason();

  useEffect(() => () => { if (thumb) URL.revokeObjectURL(thumb); }, [thumb]);
  useEffect(() => () => { if (backThumb) URL.revokeObjectURL(backThumb); }, [backThumb]);
  useEffect(() => { void backend().then((b) => b.tags()).then(setTags).catch(() => {}); }, []);

  // LEAD-05: warn when this email or phone was already captured
  useEffect(() => {
    const email = draft.fields.email?.value?.trim().toLowerCase();
    const phone = draft.fields.phone?.value?.replace(/\D/g, '') || draft.fields.mobile?.value?.replace(/\D/g, '');
    if (!email && !phone) { setDup(null); return; }
    const targetEvent = s.event_id || 'solo';
    const h = setTimeout(async () => {
      // 1. Check local IndexedDB across all leads for duplicate email or phone
      const local = await db.leads.filter((l) =>
        !l.deleted_at && (
          (!!email && l.fields.email?.value?.trim().toLowerCase() === email) ||
          (!!phone && phone.length > 6 && (l.fields.phone?.value?.replace(/\D/g, '') === phone || l.fields.mobile?.value?.replace(/\D/g, '') === phone))
        )
      ).first();

      let at = local?.created_at ?? null;
      let matchedBy = local?.fields.email?.value?.trim().toLowerCase() === email ? 'email' : 'phone';

      // 2. Check server if online
      if (!at && isOnline()) {
        at = await (await backend()).leadExists(targetEvent, email ?? '', phone ?? '').catch(() => null);
      }

      if (at) {
        const timeStr = new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const warnMsg = matchedBy === 'email' && email
          ? t('You already have an existing lead with this email address ({email}) from {time}. You can still save.', { email, time: timeStr })
          : t('You already have an existing lead with this contact ({time}). You can still save.', { time: timeStr });
        setDup(warnMsg);
        toast(warnMsg, 'info', 5000);
      } else {
        setDup(null);
      }
    }, 250);
    return () => clearTimeout(h);
  }, [draft.fields.email?.value, draft.fields.phone?.value, draft.fields.mobile?.value, s.event_id]);

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
    let extracted: Record<string, { value: string; confidence: number; reason?: string }> = {};
    let readBy: FieldValue['by'] = 'offline';

    try {
      // 1. Try local OCR service if set
      if (await localOcrAvailable()) {
        setRead('reading');
        try {
          const r = await readWithLocalOcr(blob, defs, s.company?.default_language ?? 'en');
          if (Object.values(r).some((v) => v?.value)) {
            extracted = r;
            readBy = 'offline';
          }
        } catch { /* fall through */ }
      }

      // 2. Try server cloud reader if local had nothing
      if (!Object.values(extracted).some((v) => v?.value) && isOnline() && aiAllowed) {
        setRead('reading');
        try {
          const r = await (await backend()).readCard(blob);
          if (Object.values(r).some((v) => v?.value)) {
            extracted = r;
            readBy = 'ai';
          }
        } catch (err) {
          if ((err as { code?: string }).code === 'scan_limit') throw err;
        }
      }

      // 3. Fallback to on-device Tesseract OCR if server/local returned empty
      if (!Object.values(extracted).some((v) => v?.value)) {
        setRead('reading');
        try {
          const r = await readOffline(blob, s.company?.default_language ?? 'en');
          if (Object.values(r).some((v) => v?.value)) {
            extracted = r;
            readBy = 'offline';
          }
        } catch (err) {
          console.warn('[ScanV2] on-device OCR error:', err);
        }
      }

      // 4. If Gemini is available and confidence is low or fields are missing, verify/extract with Gemini
      if (isOnline() && geminiAvailable() && hasLowConfidenceField(extracted, 0.8)) {
        setRead('reading');
        try {
          const verified = await verifyLowConfidenceWithGemini(blob, extracted, defs);
          if (Object.values(verified).some((v) => v?.value)) {
            extracted = verified;
            readBy = 'ai';
          }
        } catch (err) {
          console.warn('[ScanV2] Gemini verification error:', err);
        }
      }

      if (token !== readToken.current) return;
      fillFromRead(extracted, readBy);
      setRead(readBy);
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

  async function addBack(blob: Blob) {
    setBackPhoto(blob);
    setBackThumb(URL.createObjectURL(blob));
    setCapturingBack(false);
    setAdjust(null);
    setMode('review');
    toast(t('Back of the card added'), 'success', 1500);
    // Back often carries the address / QR — fill what the front left empty, never overwrite.
    try {
      const r = await readOffline(blob, s.company?.default_language ?? 'en', { silent: true });
      setDraft((d) => {
        const fields = { ...d.fields };
        for (const [k, v] of Object.entries(r)) if (!fields[k]?.value?.trim()) fields[k] = { ...v, by: 'offline' };
        return { ...d, fields };
      });
    } catch { /* front values stand */ }
  }

  /** Card captured: if corners were already locked on, auto-warp immediately to review; otherwise open true-up */
  async function handleShot(shot: DocShot) {
    if (isFreeOverLimit) { setPaywallOpen(true); return; }
    if (eventBlocked) { toast(t('Scanning is not allowed — this event has {reason}.', { reason: eventBlocked }), 'error'); return; }
    if (shot.quad && !capturingBack) {
      try {
        const warped = await extractCard(shot.canvas, shot.canvas.width, shot.canvas.height, shot.quad);
        if (warped) {
          const blob = await developScan(warped.canvas, 'color');
          await startReview(blob, 'camera');
          return;
        }
      } catch (err) {
        if (import.meta.env.DEV) console.warn('[ScanV2] auto-warp failed, falling back to manual adjust', err);
      }
    }
    setAdjust({ canvas: shot.canvas, quad: shot.quad, back: capturingBack });
    setMode('adjust');
  }

  /** Warped + cleaned scan → the review form (front) or the back slot. */
  async function onAdjustDone(blob: Blob) {
    if (adjust?.back) { await addBack(blob); return; }
    setAdjust(null);
    await startReview(blob, 'camera');
  }

  async function onFiles(files: FileList | File[]) {
    if (isFreeOverLimit) { setPaywallOpen(true); return; }
    if (eventBlocked) { toast(t('Scanning is not allowed — this event has {reason}.', { reason: eventBlocked }), 'error'); return; }
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
    if (!s.event_id && !isIndividual) { toast(t('Choose an event first.'), 'error'); return; }
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
      await saveLocal(newLead(emptyDraft(), 'upload', true), blob);
      setBatch({ done: i + 1, total: list.length });
    }
    toast(tn(list.length, '{n} lead saved. It will be read after sync.', '{n} leads saved. They will be read after sync.'), 'success');
    setBatch(null);
  }

  function newLead(d: Draft, src: LeadSource, hasFrontPhoto = !!photo): Lead {
    const now = nowIso();
    const otherNote = d.interest === 'other' && d.otherInterestText?.trim()
      ? `[Interest: ${d.otherInterestText.trim()}]`
      : '';
    const finalInterest = d.interest || d.leadRating || null;
    return {
      id: uuid(), company_id: s.person.company_id || s.person.id, event_id: s.event_id || 'solo', captured_by: s.person.id, captured_by_name: s.person.name,
      device: deviceLabel(), source: src, fields: d.fields, interest: finalInterest, notes: otherNote,
      consent: d.consent, consent_version: s.company?.consent_version ?? 1, consent_at: d.consent ? now : null,
      status: 'waiting', crm_error: null, crm_record_id: null, crm_history: [], has_photo: hasFrontPhoto, has_back_photo: !!backPhoto,
      tag_ids: tagIds,
      created_at: now, updated_at: now, synced_at: null, deleted_at: null,
    };
  }

  async function save() {
    if (!s.event_id && !isIndividual) { toast(t('Choose an event first (tap the event name at the top).'), 'error'); return; }
    if (eventBlocked) { toast(t('Scanning is not allowed — this event has {reason}.', { reason: eventBlocked }), 'error'); return; }
    const missing = draftErrors(defs, draft);
    const photoOnly = read === 'pending' && photo && Object.values(draft.fields).every((f) => !f.value);
    if (missing.length && !photoOnly) { setShowErrors(true); toast(t('Please check: {fields}', { fields: missing.join(', ') }), 'error'); return; }
    setSaving(true);
    try {
      const lead = newLead(draft, source);
      await saveLocal(lead, photo, backPhoto);
      toast(t('Lead saved'), 'success', 1800);
      readToken.current++;

      // Follow-up messaging feature
      const leadPhone = lead.fields.phone?.value?.trim() || lead.fields.mobile?.value?.trim() || '';
      const leadEmail = lead.fields.email?.value?.trim() || '';
      const fuConfig = getFollowUpConfig(s.person.id, s.company, s.person.role === 'staff');

      if (fuConfig.autoSend && (leadPhone || leadEmail)) {
        const msg = formatFollowUpMessage(fuConfig.message, lead, s.person.name, event?.name, s.company?.name);
        let sentAny = false;
        if (fuConfig.sendWhatsApp && leadPhone) {
          sendViaWhatsApp(leadPhone, msg);
          sentAny = true;
        }
        if (fuConfig.sendEmail && leadEmail) {
          const subj = event?.name ? `${event.name} — Great connecting with you!` : t('Great connecting with you!');
          sendViaEmail(leadEmail, subj, msg);
          sentAny = true;
        }
        if (sentAny) {
          toast(t('Follow-up message dispatched!'), 'success', 3000);
        }
        setMode('camera');
      } else if (!fuConfig.autoSend && (leadPhone || leadEmail)) {
        // Toggle is OFF: give the user options where they want to push the message
        setFollowUpLead(lead);
        setFuModalOpen(true);
        setMode('camera');
      } else {
        setMode('camera'); // next scan ready at once (SCAN-08)
      }

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

  const [retrying, setRetrying] = useState(false);
  async function retryRead() {
    if (!photo || retrying) return;
    const token = ++readToken.current;
    setRetrying(true);
    setRead('reading');
    try {
      const r = await readOffline(photo, s.company?.default_language ?? 'en');
      if (token !== readToken.current) return;
      fillFromRead(r, 'offline');
      setRead('offline');
    } catch {
      if (token === readToken.current) setRead('pending');
    } finally {
      setRetrying(false);
    }
  }

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
        {thumb ? <img src={thumb} alt={t('Front of the card')} class="card-photo h-12 w-19 rounded-lg border border-line object-cover" /> : <span class="flex h-12 w-19 items-center justify-center rounded-lg bg-subtle text-muted"><Keyboard class="size-5" /></span>}
        {backThumb && (
          <span class="relative">
            <img src={backThumb} alt={t('Back of the card')} class="card-photo h-12 w-19 rounded-lg border border-line object-cover" />
            <button class="absolute -top-1.5 -right-1.5 rounded-full bg-black/80 p-0.5 text-white" onClick={() => { setBackPhoto(null); setBackThumb(null); }} aria-label={t('Remove the back photo')}><X class="size-3" /></button>
          </span>
        )}
        <div class="min-w-0">
          <p class="text-sm font-bold">{t('Review & save')}</p>
          <ReadBadge state={read} />
        </div>
        {(read === 'pending' || read === 'offline') && photo && (
          <button class="btn-secondary ml-auto min-h-10 shrink-0 px-3 text-xs" disabled={retrying} onClick={() => void retryRead()}>
            {retrying ? <Spinner class="size-4" /> : <RotateCcw class="size-4" />}{t('Re-read')}
          </button>
        )}
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
        {s.person.role !== 'individual' && tags.length > 0 && (
          <div class="mb-4"><TagPicker tags={tags} selected={tagIds} onChange={setTagIds} /></div>
        )}
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
          {!event && !isIndividual && <div class="bg-amber-100 px-4 py-2 text-center text-xs font-semibold text-amber-900">{t('No event selected — tap the event name at the top.')}</div>}
          {event && eventBlocked && (
            <div class="flex items-center justify-center gap-2 px-4 py-3 text-center text-xs font-semibold text-white" style={eventBlocked === t('upcoming') ? 'background:#6366f1' : 'background:#dc2626'}>
              {eventBlocked === t('upcoming') ? <CalendarClock class="size-4 shrink-0" /> : <Lock class="size-4 shrink-0" />}
              <span>{eventBlocked === t('upcoming') ? t('This event has not started yet. Scanning opens on {date}.', { date: new Date(event.starts_on).toLocaleDateString() }) : t('This event has ended. You can view existing scans but no new cards can be scanned.')}</span>
            </div>
          )}
          {capturingBack && (
            <div class="flex items-center justify-between gap-2 bg-ocean-600 px-4 py-2 text-xs font-semibold text-white">
              <span>{t('Now hold the back of the card in the frame')}</span>
              <button class="rounded-full bg-black/20 px-2 py-1" onClick={() => { setCapturingBack(false); }}>{t('Cancel')}</button>
            </div>
          )}
          <div class="relative min-h-0 flex-1">
            {eventBlocked ? (
              <div class="flex size-full flex-col items-center justify-center gap-3 bg-subtle p-6 text-center">
                <span class="flex size-16 items-center justify-center rounded-full bg-red-100 text-red-600">
                  <Lock class="size-8" />
                </span>
                <p class="text-sm font-bold text-ink">{t('Event Scanning Closed')}</p>
                <p class="max-w-xs text-xs text-muted leading-relaxed">
                  {t('This event has ended. You can view existing scans but no new cards can be scanned.')}
                </p>
              </div>
            ) : (
              <DocCamera active={mode === 'camera' && !eventBlocked} handle={(h) => { cam.current = h; }} onShot={(shot) => void handleShot(shot)} />
            )}
          </div>
          <div class="flex items-center justify-around gap-4 bg-surface px-6 py-4 lg:bg-subtle">
            <button class="flex w-16 flex-col items-center gap-1 text-xs font-semibold text-muted hover:text-ocean-600 disabled:opacity-40 disabled:pointer-events-none" disabled={!!eventBlocked} onClick={() => fileInput.current?.click()}>
              <span class="flex size-12 items-center justify-center rounded-full border border-line bg-surface"><Upload class="size-5" /></span>{t('Upload')}
            </button>
            <button class="group flex size-18 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-ocean-600 p-1 shadow-lg disabled:opacity-40 disabled:pointer-events-none" disabled={!!eventBlocked} onClick={() => cam.current?.capture()} aria-label={t('Capture')}>
              <span class="flex size-full items-center justify-center rounded-full border-4 border-white bg-brand-700 transition group-active:scale-90"><ScanSearch class="size-6 text-white" /></span>
            </button>
            <button class="flex w-16 flex-col items-center gap-1 text-xs font-semibold text-muted hover:text-ocean-600 disabled:opacity-40 disabled:pointer-events-none" disabled={!!eventBlocked} onClick={() => void startReview(null, 'manual')}>
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

      {/* ── Quota Reached Paywall Modal ── */}
      <Dialog
        open={paywallOpen}
        onClose={() => setPaywallOpen(false)}
        title={t('Monthly Scan Limit Reached')}
        footer={<>
          <button class="btn-ghost" onClick={() => setPaywallOpen(false)}>{t('Maybe later')}</button>
          <a
            href={linkFor(s.person.role, '/upgrade')}
            class="btn-primary font-bold gap-2 px-5"
          >
            <Crown class="size-4" />
            <span>{t('Upgrade to Pro ($100/mo)')}</span>
          </a>
        </>}
      >
        <div class="text-center py-4 space-y-3">
          <div class="size-14 rounded-2xl bg-amber-500/15 text-amber-600 dark:text-amber-400 mx-auto flex items-center justify-center border border-amber-500/30">
            <Zap class="size-7" />
          </div>
          <h3 class="text-lg font-bold text-ink">{t('You have used all 5 free scans this month')}</h3>
          <p class="text-xs text-muted max-w-sm mx-auto leading-relaxed">
            {t('Upgrade to WeTa Snap Pro for unlimited card scanning, advanced Google Gemini AI field verification, and full export capabilities.')}
          </p>
          <div class="p-3 rounded-xl bg-subtle border border-line text-xs font-semibold text-ink flex items-center justify-around">
            <span>{t('Monthly:')} <strong class="text-emerald-600 dark:text-emerald-400">$100 / mo</strong></span>
            <span>•</span>
            <span>{t('Annual:')} <strong class="text-emerald-600 dark:text-emerald-400">$1,150 / yr</strong></span>
          </div>
        </div>
      </Dialog>

      <FollowUpModal
        open={fuModalOpen}
        onClose={() => { setFuModalOpen(false); setFollowUpLead(null); setMode('camera'); }}
        lead={followUpLead}
        senderName={s.person.name}
        eventName={event?.name}
        companyName={s.company?.name || getFollowUpConfig(s.person.id, s.company, s.person.role === 'staff').senderCompanyName}
        config={getFollowUpConfig(s.person.id, s.company, s.person.role === 'staff')}
      />
    </div>
  );
}
