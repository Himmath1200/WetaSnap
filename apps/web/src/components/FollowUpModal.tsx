import { useEffect, useRef, useState } from 'preact/hooks';
import { MessageSquare, Mail, Check, ArrowRight, Link, Image, FileText, Globe, Share2, X } from 'lucide-preact';
import { Dialog } from './ui';
import { t } from '../lib/i18n';
import {
  type FollowUpConfig,
  formatFollowUpMessage,
  sendViaWhatsApp,
  sendViaEmail,
  shareViaNativeSheet,
} from '../lib/followup';
import type { Lead } from '../lib/types';

interface Props {
  open: boolean;
  onClose: () => void;
  lead: Lead | null;
  senderName: string;
  eventName?: string;
  companyName?: string;
  config: FollowUpConfig;
}

export function FollowUpModal({ open, onClose, lead, senderName, eventName, companyName, config }: Props) {
  if (!lead) return null;

  const phone = lead.fields.phone?.value?.trim() || lead.fields.mobile?.value?.trim() || '';
  const email = lead.fields.email?.value?.trim() || '';
  const leadName = lead.fields.full_name?.value || lead.fields.first_name?.value || t('Contact');
  const company = lead.fields.company?.value || lead.fields.company_name?.value || '';

  const initialText = formatFollowUpMessage(config.message, lead, senderName, eventName, companyName, config.attachmentUrl, config.websiteUrl);
  const [customText, setCustomText] = useState(initialText);
  const [sentWa, setSentWa] = useState(false);
  const [sentMail, setSentMail] = useState(false);
  const [sentShare, setSentShare] = useState(false);

  // Attached media files: Real images, videos, PDFs
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<{ name: string; url: string; type: string; size: string }[]>([]);

  const [inputUrl, setInputUrl] = useState('');
  const [urlType, setUrlType] = useState<'website' | 'media'>('website');
  const [showAddUrl, setShowAddUrl] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (lead) {
      setCustomText(formatFollowUpMessage(config.message, lead, senderName, eventName, companyName, config.attachmentUrl, config.websiteUrl));
      setSentWa(false);
      setSentMail(false);
      setSentShare(false);
      setInputUrl('');
      setShowAddUrl(false);
      setAttachedFiles([]);
      setPreviews([]);
    }
  }, [lead?.id, config.message, config.attachmentUrl, config.websiteUrl, senderName, eventName, companyName]);

  const handleAppendUrl = (url: string, prefix = '') => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const formatted = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const toAppend = prefix ? `\n\n${prefix}: ${formatted}` : `\n\n${formatted}`;
    if (!customText.includes(formatted)) {
      setCustomText((prev) => prev.trim() + toAppend);
    }
    setInputUrl('');
    setShowAddUrl(false);
  };

  const handleFileUpload = (e: Event) => {
    const files = (e.target as HTMLInputElement).files;
    if (!files || files.length === 0) return;

    const newFiles: File[] = Array.from(files);
    setAttachedFiles((prev) => [...prev, ...newFiles]);

    const newPreviews = newFiles.map((file) => {
      const url = URL.createObjectURL(file);
      const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
      const sizeStr = file.size > 1024 * 1024 ? `${sizeMb} MB` : `${Math.round(file.size / 1024)} KB`;
      return {
        name: file.name,
        url,
        type: file.type,
        size: sizeStr,
      };
    });

    setPreviews((prev) => [...prev, ...newPreviews]);
    (e.target as HTMLInputElement).value = '';
  };

  const removeFile = (index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
    setPreviews((prev) => {
      URL.revokeObjectURL(prev[index]?.url ?? '');
      return prev.filter((_, i) => i !== index);
    });
  };

  const canNativeShare = typeof navigator !== 'undefined' && !!navigator.share;

  const handleNativeShare = async () => {
    const title = eventName ? `${eventName} — Follow-up` : t('Follow-up');
    const ok = await shareViaNativeSheet(title, customText, attachedFiles.length > 0 ? attachedFiles : undefined);
    if (ok) setSentShare(true);
  };

  const handleWhatsApp = async () => {
    if (attachedFiles.length > 0 && canNativeShare) {
      // Direct file attachment support via device share sheet
      const ok = await shareViaNativeSheet(leadName, customText, attachedFiles);
      if (ok) {
        setSentWa(true);
        return;
      }
    }
    // Direct WhatsApp Web/App deep link
    if (!phone) return;
    sendViaWhatsApp(phone, customText);
    setSentWa(true);
  };

  const handleEmail = async () => {
    const subject = eventName ? `${eventName} — Great connecting with you!` : t('Great connecting with you!');
    if (attachedFiles.length > 0 && canNativeShare) {
      const ok = await shareViaNativeSheet(subject, customText, attachedFiles);
      if (ok) {
        setSentMail(true);
        return;
      }
    }
    if (!email) return;
    sendViaEmail(email, subject, customText);
    setSentMail(true);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('Send Follow-Up Message')}
      footer={
        <div class="flex items-center justify-between w-full">
          <span class="text-xs text-muted">
            {t('Lead saved to device.')}
          </span>
          <button
            type="button"
            class="btn-primary text-xs font-semibold gap-1.5 px-4"
            onClick={onClose}
          >
            <span>{t('Next Scan')}</span>
            <ArrowRight class="size-3.5" />
          </button>
        </div>
      }
    >
      <div class="space-y-4">
        {/* Recipient card header */}
        <div class="rounded-xl border border-line bg-subtle p-3 flex items-center justify-between gap-3">
          <div class="min-w-0">
            <p class="font-bold text-ink text-sm truncate">{leadName}</p>
            {company && <p class="text-xs text-muted truncate">{company}</p>}
          </div>
          <div class="flex items-center gap-2 text-xs text-muted shrink-0">
            {phone && <span class="rounded bg-surface border border-line px-2 py-0.5 font-mono">{phone}</span>}
          </div>
        </div>

        {/* Message preview / edit box */}
        <div>
          <div class="flex items-center justify-between mb-1.5 flex-wrap gap-1">
            <label class="label mb-0" for="fu-preview">{t('Message to send')}</label>
            {/* Media & URL Direct Attachment Buttons */}
            <div class="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={() => { setUrlType('website'); setShowAddUrl((v) => !v); }}
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border border-line bg-subtle hover:bg-surface text-[11px] font-medium text-ink transition active:scale-95 cursor-pointer"
                title={t('Add Website or Link')}
              >
                <Globe class="size-3 text-ocean-600" />
                <span>{t('Website URL')}</span>
              </button>

              <button
                type="button"
                onClick={() => { setUrlType('media'); setShowAddUrl((v) => !v); }}
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border border-line bg-subtle hover:bg-surface text-[11px] font-medium text-ink transition active:scale-95 cursor-pointer"
                title={t('Add Link to Photo, Video, or Cloud Folder')}
              >
                <Link class="size-3 text-brand-600" />
                <span>{t('Web Link')}</span>
              </button>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg border border-brand-500/40 bg-brand-50 hover:bg-brand-100 text-[11px] font-semibold text-brand-700 transition active:scale-95 cursor-pointer"
                title={t('Attach Image, Video or PDF')}
              >
                <Image class="size-3 text-brand-600" />
                <span>{t('+ Attach File')}</span>
              </button>

              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,video/*,application/pdf"
                class="hidden"
                onChange={handleFileUpload}
              />
            </div>
          </div>

          {/* Expandable URL Input Field */}
          {showAddUrl && (
            <div class="mb-2 p-2.5 rounded-xl border border-brand-500/30 bg-brand-50/20 flex items-center gap-2 animate-in fade-in">
              <input
                type="url"
                class="input text-xs flex-1 py-1 px-2.5 h-8"
                placeholder={urlType === 'website' ? t('https://yourwebsite.com or product link') : t('https://example.com/video.mp4 or brochure link')}
                value={inputUrl}
                onInput={(e) => setInputUrl(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAppendUrl(inputUrl, urlType === 'website' ? 'Website' : 'Link');
                  }
                }}
                autoFocus
              />
              <button
                type="button"
                class="btn-primary text-xs py-1 px-3 h-8 shrink-0 font-semibold cursor-pointer"
                onClick={() => handleAppendUrl(inputUrl, urlType === 'website' ? 'Website' : 'Link')}
              >
                {t('Add to message')}
              </button>
            </div>
          )}

          <textarea
            id="fu-preview"
            rows={4}
            class="input text-xs leading-relaxed"
            value={customText}
            onInput={(e) => setCustomText(e.currentTarget.value)}
          />

          {/* Attached Files Gallery */}
          {previews.length > 0 && (
            <div class="mt-2.5 p-2.5 rounded-xl border border-line bg-subtle space-y-2">
              <div class="flex items-center justify-between">
                <span class="text-[11px] font-bold text-ink uppercase tracking-wider flex items-center gap-1.5">
                  <Image class="size-3.5 text-brand-600" />
                  {t('Attached Files ({count})', { count: previews.length })}
                </span>
                <span class="text-[10px] text-muted">
                  {t('Direct file sharing supported via device share')}
                </span>
              </div>
              <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {previews.map((item, idx) => (
                  <div key={idx} class="group relative rounded-lg border border-line bg-surface p-1.5 flex items-center gap-2 min-w-0">
                    {item.type.startsWith('image') ? (
                      <img src={item.url} alt={item.name} class="size-10 rounded object-cover shrink-0 border border-line/40" />
                    ) : item.type.startsWith('video') ? (
                      <div class="size-10 rounded bg-slate-900 text-white flex items-center justify-center shrink-0">
                        <span class="text-[9px] font-bold">VIDEO</span>
                      </div>
                    ) : (
                      <div class="size-10 rounded bg-rose-50 text-rose-600 flex items-center justify-center shrink-0 border border-rose-200">
                        <FileText class="size-5" />
                      </div>
                    )}
                    <div class="min-w-0 flex-1">
                      <p class="text-[11px] font-medium text-ink truncate leading-tight">{item.name}</p>
                      <p class="text-[9px] text-muted">{item.size}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeFile(idx)}
                      class="absolute -top-1.5 -right-1.5 size-4 rounded-full bg-slate-700 text-white flex items-center justify-center text-[10px] shadow hover:bg-rose-600 transition"
                      title={t('Remove')}
                    >
                      <X class="size-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Channels action buttons */}
        <div class="space-y-2 pt-1">
          <p class="text-xs font-bold text-muted uppercase tracking-wider">{t('Push message to:')}</p>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {/* WhatsApp Push Button */}
            <button
              type="button"
              disabled={!phone}
              onClick={handleWhatsApp}
              class={`flex items-center justify-between p-3 rounded-xl border text-left transition ${
                !phone
                  ? 'opacity-40 border-line bg-subtle cursor-not-allowed'
                  : sentWa
                  ? 'border-emerald-500 bg-emerald-500/10 text-emerald-700'
                  : 'border-emerald-500/40 bg-emerald-500/5 hover:bg-emerald-500/10 hover:border-emerald-500 text-ink cursor-pointer'
              }`}
            >
              <div class="flex items-center gap-2.5 min-w-0">
                <span class="size-8 rounded-lg bg-emerald-500 text-white flex items-center justify-center shrink-0">
                  <MessageSquare class="size-4" />
                </span>
                <div class="min-w-0">
                  <p class="text-xs font-bold truncate">{t('WhatsApp')}</p>
                  <p class="text-[10px] text-muted truncate">{phone || t('No phone number')}</p>
                </div>
              </div>
              {sentWa ? (
                <span class="size-5 rounded-full bg-emerald-500 text-white flex items-center justify-center shrink-0">
                  <Check class="size-3" />
                </span>
              ) : (
                <span class="text-xs font-semibold text-emerald-600 shrink-0">{t('Send')} →</span>
              )}
            </button>

            {/* Email Push Button */}
            <button
              type="button"
              disabled={!email}
              onClick={handleEmail}
              class={`flex items-center justify-between p-3 rounded-xl border text-left transition ${
                !email
                  ? 'opacity-40 border-line bg-subtle cursor-not-allowed'
                  : sentMail
                  ? 'border-sky-500 bg-sky-500/10 text-sky-700'
                  : 'border-sky-500/40 bg-sky-500/5 hover:bg-sky-500/10 hover:border-sky-500 text-ink cursor-pointer'
              }`}
            >
              <div class="flex items-center gap-2.5 min-w-0">
                <span class="size-8 rounded-lg bg-sky-500 text-white flex items-center justify-center shrink-0">
                  <Mail class="size-4" />
                </span>
                <div class="min-w-0">
                  <p class="text-xs font-bold truncate">{t('Email')}</p>
                  <p class="text-[10px] text-muted truncate">{email || t('No email address')}</p>
                </div>
              </div>
              {sentMail ? (
                <span class="size-5 rounded-full bg-sky-500 text-white flex items-center justify-center shrink-0">
                  <Check class="size-3" />
                </span>
              ) : (
                <span class="text-xs font-semibold text-sky-600 shrink-0">{t('Send')} →</span>
              )}
            </button>
          </div>

          {/* Device Share Sheet (Sends message + files directly to WhatsApp, Gmail, Telegram, AirDrop, etc.) */}
          {canNativeShare && (
            <button
              type="button"
              onClick={handleNativeShare}
              class={`w-full flex items-center justify-between p-2.5 rounded-xl border text-left transition ${
                sentShare
                  ? 'border-brand-500 bg-brand-500/10 text-brand-700'
                  : 'border-brand-500/30 bg-brand-500/5 hover:bg-brand-500/10 hover:border-brand-500 text-ink cursor-pointer'
              }`}
            >
              <div class="flex items-center gap-2.5 min-w-0">
                <span class="size-7 rounded-lg bg-brand-600 text-white flex items-center justify-center shrink-0">
                  <Share2 class="size-3.5" />
                </span>
                <div class="min-w-0">
                  <p class="text-xs font-bold truncate">{t('Share via App / More Options')}</p>
                  <p class="text-[10px] text-muted truncate">
                    {attachedFiles.length > 0
                      ? t('Shares text message with all {count} attached files', { count: attachedFiles.length })
                      : t('Open phone share sheet (AirDrop, WhatsApp, Messages, etc.)')}
                  </p>
                </div>
              </div>
              {sentShare ? (
                <span class="size-5 rounded-full bg-brand-600 text-white flex items-center justify-center shrink-0">
                  <Check class="size-3" />
                </span>
              ) : (
                <span class="text-xs font-semibold text-brand-600 shrink-0">{t('Share')} →</span>
              )}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
