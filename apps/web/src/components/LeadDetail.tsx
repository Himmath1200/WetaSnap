import { useEffect, useState } from 'preact/hooks';
import {
  AlertTriangle, CheckCircle2, ExternalLink, Mail, MapPin, MessageSquare, Pencil, Phone, Globe, Share2, Trash2, UserPlus, ZoomIn, Image as ImageIcon,
} from 'lucide-preact';
import { LeadForm, draftErrors, type Draft } from './LeadForm';
import { TagChips, TagPicker } from './TagPicker';
import { Dialog, InterestPill, Sheet, Spinner, StatusPill } from './ui';
import { backend } from '../lib/backend';
import { db } from '../lib/db';
import { saveEdit } from '../lib/sync';
import { isOnline } from '../lib/net';
import { useStore, toast } from '../lib/store';
import { config, session } from '../lib/session';
import { leadName } from '../lib/leads';
import { ClipboardFallback, actionHref, saveToPhone, shareCardPhoto, shareContact } from '../lib/contact';
import { getFollowUpConfig, formatFollowUpMessage, sendViaWhatsApp, sendViaEmail } from '../lib/followup';
import { t } from '../lib/i18n';
import type { Lead, Tag } from '../lib/types';

interface Props {
  lead: Lead | null;
  tags: Tag[];
  /** admin: saves on the server and can resend/delete. staff: saves to the device outbox. */
  mode: 'admin' | 'staff';
  onClose: () => void;
  onChanged?: () => void;
}

/**
 * One lead, opened from S4 or S5. It opens as a **preview** — nothing is editable until
 * Edit is pressed (client brief). Phone, email, website and address are tappable, and the
 * lead can be saved to the phone's contacts or shared.
 */
export function LeadDetail({ lead, tags, mode, onClose, onChanged }: Props) {
  const s = useStore(session)!;
  const cfg = useStore(config);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [photo, setPhoto] = useState<string | null>(null);
  const [back, setBack] = useState<string | null>(null);
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!lead) return;
    setEditing(false);
    setDraft({ fields: lead.fields, interest: lead.interest, notes: lead.notes, consent: lead.consent });
    setTagIds(lead.tag_ids);
    setShowErrors(lead.status === 'check');
    setPhoto(null); setBack(null); setPhotoBlob(null);
    const urls: string[] = [];
    void (async () => {
      // On a phone the photo is usually still on the device; admins get a signed link.
      const local = await db.photos.get([lead.id, 'front']);
      const localBack = await db.photos.get([lead.id, 'back']);
      if (local) {
        const u = URL.createObjectURL(local.blob);
        urls.push(u);
        setPhoto(u);
        setPhotoBlob(local.blob);
      } else {
        const remote = await (await backend()).photoUrl(lead.id).catch(() => null);
        if (remote) {
          urls.push(remote);
          setPhoto(remote);
        }
      }
      if (localBack) {
        const u = URL.createObjectURL(localBack.blob);
        urls.push(u);
        setBack(u);
      }
    })();
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [lead?.id]);

  const event = lead ? cfg.events.find((e) => e.id === lead.event_id) : null;
  const defs = cfg.fields;

  async function save() {
    if (!lead || !draft) return;
    const missing = draftErrors(defs, draft);
    if (missing.length) { setShowErrors(true); toast(t('Please check: {fields}', { fields: missing.join(', ') }), 'error'); return; }
    setSaving(true);
    try {
      const next: Lead = { ...lead, ...draft, tag_ids: tagIds, consent_at: draft.consent ? lead.consent_at ?? new Date().toISOString() : null };
      if (mode === 'admin') {
        await (await backend()).saveLead(next, true);
        toast(t('Saved and re-sent to the CRM'), 'success');
      } else {
        await saveEdit(next);
        toast(t('Saved — the lead will be re-sent as an update'), 'success');
      }
      setEditing(false);
      onChanged?.();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  }

  /**
   * Admins delete any lead; staff delete leads they captured (client decision, 22 Sep 2026).
   * Always a soft delete on the server — an admin can restore it for 30 days. A lead that never
   * left this phone is simply removed from the device.
   */
  async function remove() {
    if (!lead) return;
    try {
      const neverSent = mode === 'staff' && !lead.synced_at;
      if (neverSent) {
        await db.transaction('rw', db.leads, db.photos, async () => {
          await db.leads.delete(lead.id);
          await db.photos.where('lead_id').equals(lead.id).delete();
        });
      } else {
        if (!isOnline()) throw new Error(t('Connect to the internet to delete a lead that has already been sent.'));
        await (await backend()).deleteLead(lead.id);
        await db.leads.update(lead.id, { deleted_at: new Date().toISOString() }).catch(() => 0);
      }
      setConfirmDelete(false);
      toast(neverSent ? t('Card removed from this device.') : t('Card moved to Recycle Bin. Auto-deleted after 30 days.'), 'success');
      onChanged?.();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  async function onShareContact() {
    if (!lead) return;
    try {
      await shareContact(lead, defs, event?.name);
    } catch (e) {
      if (e instanceof ClipboardFallback) toast(t('Contact details copied — paste them where you need them.'), 'success');
      else if ((e as Error).name !== 'AbortError') toast(t('Sharing is not available on this device.'), 'error');
    }
  }

  return (
    <>
      <Sheet
        open={!!lead && !!draft} onClose={onClose} wide
        title={lead ? <span class="flex min-w-0 items-center gap-2"><span class="truncate">{leadName(lead)}</span><StatusPill status={lead.status} /></span> : ''}
        footer={
          editing ? (
            <>
              <button class="btn-ghost" onClick={() => { setEditing(false); if (lead) setDraft({ fields: lead.fields, interest: lead.interest, notes: lead.notes, consent: lead.consent }); }}>{t('Cancel')}</button>
              <button class="btn-primary ml-auto min-w-36" disabled={saving} onClick={() => void save()}>
                {saving ? <Spinner /> : mode === 'admin' ? t('Save & resend') : t('Save')}
              </button>
            </>
          ) : (
            <>
              {(mode === 'admin' || lead?.captured_by === s.person.id) && (
                <button class="btn-danger px-3" onClick={() => setConfirmDelete(true)} aria-label={t('Delete lead')}><Trash2 class="size-4" /></button>
              )}
              <button class="btn-primary ml-auto min-w-32" onClick={() => setEditing(true)}><Pencil class="size-4" />{t('Edit')}</button>
            </>
          )
        }
      >
        {lead && draft && (
          <div class="space-y-5">
            {lead.crm_error && !editing && (
              <div class="flex gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">
                <AlertTriangle class="mt-0.5 size-4 shrink-0" /><span>{lead.crm_error}</span>
              </div>
            )}

            {(photo || back) && (
              <div class="flex items-start gap-2">
                {[['front', photo], ['back', back]].map(([side, url]) =>
                  url ? (
                    <button key={side} class="group relative block min-w-0 flex-1 overflow-hidden rounded-xl border border-line bg-white p-0" onClick={() => setZoom(url as string)}>
                      <img src={url as string} alt={side === 'front' ? t('Front of the card') : t('Back of the card')} class="card-photo block h-auto w-full" />
                      <span class="absolute right-2 bottom-2 rounded-full bg-black/50 p-1.5 text-white"><ZoomIn class="size-4" /></span>
                      {back && <span class="absolute top-2 left-2 rounded-full bg-black/50 px-2 py-0.5 text-[11px] font-semibold text-white">{side === 'front' ? t('Front') : t('Back')}</span>}
                    </button>
                  ) : null,
                )}
              </div>
            )}

            {!editing ? (
              <>
                <TagChips ids={lead.tag_ids} tags={tags} />

                <dl class="divide-y divide-line overflow-hidden rounded-xl border border-line">
                  {defs.map((d) => {
                    const value = lead.fields[d.key]?.value?.trim() ?? '';
                    if (!value) return null;
                    const href = actionHref(d.type, value, d.key);
                    const Icon = d.type === 'phone' ? Phone : d.type === 'email' ? Mail : d.type === 'link' ? Globe : d.key === 'address' ? MapPin : null;
                    return (
                      <div key={d.id} class="flex items-center gap-3 px-3 py-2">
                        <dt class="w-28 shrink-0 text-xs font-semibold text-muted">{d.label}</dt>
                        <dd class="min-w-0 flex-1 text-sm">
                          {href ? (
                            <a href={href} target={d.type === 'link' || d.key === 'address' ? '_blank' : undefined} rel="noreferrer"
                              class="inline-flex min-h-11 items-center gap-1.5 font-medium text-ocean-700 hover:underline">
                              {Icon && <Icon class="size-3.5 shrink-0" />}<span class="break-all">{value}</span>
                              {(d.type === 'link' || d.key === 'address') && <ExternalLink class="size-3 shrink-0 opacity-60" />}
                            </a>
                          ) : (
                            <span class="break-words">{value}</span>
                          )}
                        </dd>
                      </div>
                    );
                  })}
                </dl>

                <div class="flex flex-wrap items-center gap-2">
                  <InterestPill interest={lead.interest} />
                  <span class={`pill ${lead.consent ? 'bg-brand-50 text-brand-800' : 'bg-subtle text-muted'}`}>
                    {lead.consent ? <><CheckCircle2 class="size-3.5" />{t('Consent given')}</> : t('No consent')}
                  </span>
                </div>

                <div class="grid grid-cols-2 gap-2">
                  <button class="btn-secondary" onClick={() => saveToPhone(lead, defs, event?.name)}><UserPlus class="size-4" />{t('Save to device')}</button>
                  <button class="btn-secondary" onClick={() => void onShareContact()}><Share2 class="size-4" />{t('Share contact')}</button>
                  {photoBlob && (
                    <button class="btn-secondary col-span-2" onClick={() => void shareCardPhoto(photoBlob, lead)}><ImageIcon class="size-4" />{t('Share card photo')}</button>
                  )}
                  {lead.fields.phone?.value && (
                    <button
                      class="btn-secondary text-xs font-semibold gap-1.5 border-emerald-500/30 text-emerald-700 bg-emerald-500/5 hover:bg-emerald-500/10"
                      onClick={() => {
                        const fu = getFollowUpConfig(s.person.id, s.company, s.person.role === 'staff');
                        const coName = s.company?.name || fu.senderCompanyName;
                        const msg = formatFollowUpMessage(fu.message, lead, s.person.name, event?.name, coName);
                        sendViaWhatsApp(lead.fields.phone!.value, msg);
                      }}
                    >
                      <MessageSquare class="size-3.5 text-emerald-600 shrink-0" />
                      <span class="truncate">{t('Follow-up WhatsApp')}</span>
                    </button>
                  )}
                  {lead.fields.email?.value && (
                    <button
                      class="btn-secondary text-xs font-semibold gap-1.5 border-sky-500/30 text-sky-700 bg-sky-500/5 hover:bg-sky-500/10"
                      onClick={() => {
                        const fu = getFollowUpConfig(s.person.id, s.company, s.person.role === 'staff');
                        const coName = s.company?.name || fu.senderCompanyName;
                        const msg = formatFollowUpMessage(fu.message, lead, s.person.name, event?.name, coName);
                        const subj = event?.name ? `${event.name} — Great connecting with you!` : t('Great connecting with you!');
                        sendViaEmail(lead.fields.email!.value, subj, msg);
                      }}
                    >
                      <Mail class="size-3.5 text-sky-600 shrink-0" />
                      <span class="truncate">{t('Follow-up Email')}</span>
                    </button>
                  )}
                </div>

                <dl class="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  {event?.name && <><dt class="text-muted">{t('Event')}</dt><dd class="font-medium">{event.name}</dd></>}
                  <dt class="text-muted">{t('Captured at')}</dt><dd class="font-medium">{new Date(lead.created_at).toLocaleString()}</dd>
                  <dt class="text-muted">{t('Device · source')}</dt><dd class="font-medium">{lead.device} · {t(lead.source)}</dd>
                </dl>

                {mode === 'admin' && (
                  <section>
                    <h3 class="label">{t('Delivery history')}</h3>
                    <ol class="space-y-2 border-l-2 border-line pl-4 text-xs">
                      <li class="relative"><span class="absolute top-1 -left-[21px] size-2.5 rounded-full bg-ocean-500" />{t('Captured on device')} · {new Date(lead.created_at).toLocaleString()}</li>
                      {lead.synced_at && <li class="relative"><span class="absolute top-1 -left-[21px] size-2.5 rounded-full bg-ocean-500" />{t('Synced from the device')} · {new Date(lead.synced_at).toLocaleString()}</li>}
                      {lead.crm_history.map((h, i) => (
                        <li key={i} class="relative">
                          <span class={`absolute top-1 -left-[21px] size-2.5 rounded-full ${h.ok ? 'bg-brand-500' : 'bg-red-500'}`} />
                          <span class={`inline-flex items-center gap-1 font-semibold ${h.ok ? 'text-brand-800' : 'text-red-700'}`}>
                            {h.ok ? <CheckCircle2 class="size-3.5" /> : <AlertTriangle class="size-3.5" />}{h.ok ? t('CRM accepted') : t('CRM rejected')}
                          </span> · {new Date(h.at).toLocaleString()}
                          <span class="block font-mono text-[11px] text-muted">{h.message}</span>
                        </li>
                      ))}
                    </ol>
                  </section>
                )}
              </>
            ) : (
              <>
                <TagPicker tags={tags} selected={tagIds} onChange={setTagIds} />
                <LeadForm defs={defs} draft={draft} onChange={setDraft} company={s.company} showErrors={showErrors} crmError={lead.crm_error} idPrefix="detail" />
              </>
            )}
          </div>
        )}
      </Sheet>

      {zoom && (
        <div class="fixed inset-0 z-[70] flex items-center justify-center bg-black/85 p-4" onClick={() => setZoom(null)}>
          <img src={zoom} alt={t('Card photo')} class="max-h-full max-w-full rounded-lg" />
        </div>
      )}

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title={t('Move to Recycle Bin?')}
        footer={<>
          <button class="btn-ghost" onClick={() => setConfirmDelete(false)}>{t('Cancel')}</button>
          <button class="btn bg-red-600 text-white hover:bg-red-700" onClick={() => void remove()}>{t('Move to Recycle Bin')}</button>
        </>}>
        <div class="space-y-2 text-sm text-slate-700">
          <p>{t('The card will be moved to the Recycle Bin.')}</p>
          <p class="text-xs bg-subtle p-2.5 rounded-xl border border-line text-ink">
            🕒 {t('Cards in the Recycle Bin are kept safely and will be permanently deleted after 30 days.')}
          </p>
        </div>
      </Dialog>
    </>
  );
}
