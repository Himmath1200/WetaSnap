import { useEffect, useRef, useState } from 'preact/hooks';
import { MessageSquare, Mail, Check, ArrowRight, Link, Image, Globe } from 'lucide-preact';
import { Dialog } from './ui';
import { t } from '../lib/i18n';
import {
  type FollowUpConfig,
  formatFollowUpMessage,
  sendViaWhatsApp,
  sendViaEmail,
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

  const [inputUrl, setInputUrl] = useState('');
  const [urlType, setUrlType] = useState<'website' | 'media'>('website');
  const [showAddUrl, setShowAddUrl] = useState(false);
  const mediaInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (lead) {
      setCustomText(formatFollowUpMessage(config.message, lead, senderName, eventName, companyName, config.attachmentUrl, config.websiteUrl));
      setSentWa(false);
      setSentMail(false);
      setInputUrl('');
      setShowAddUrl(false);
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

  const handleMediaUpload = (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const isVideo = file.type.startsWith('video');
    const label = isVideo ? t('Video attachment') : t('Photo attachment');
    const note = `\n\n[${label}: ${file.name}]`;
    setCustomText((prev) => prev.trim() + note);
    (e.target as HTMLInputElement).value = '';
  };

  const handleWhatsApp = () => {
    if (!phone) return;
    sendViaWhatsApp(phone, customText);
    setSentWa(true);
  };

  const handleEmail = () => {
    if (!email) return;
    const subject = eventName ? `${eventName} — Great connecting with you!` : t('Great connecting with you!');
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
          <div class="flex items-center justify-between mb-1.5">
            <label class="label mb-0" for="fu-preview">{t('Message to send')}</label>
            {/* Media & URL Quick Append Buttons */}
            <div class="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => { setUrlType('website'); setShowAddUrl((v) => !v); }}
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border border-line bg-subtle hover:bg-surface text-[11px] font-medium text-ink transition active:scale-95 cursor-pointer"
                title={t('Add Website or Link')}
              >
                <Globe class="size-3 text-ocean-600" />
                <span>{t('Website / URL')}</span>
              </button>
              <button
                type="button"
                onClick={() => { setUrlType('media'); setShowAddUrl((v) => !v); }}
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border border-line bg-subtle hover:bg-surface text-[11px] font-medium text-ink transition active:scale-95 cursor-pointer"
                title={t('Add Link to Photo or Video')}
              >
                <Link class="size-3 text-brand-600" />
                <span>{t('Media Link')}</span>
              </button>
              <button
                type="button"
                onClick={() => mediaInputRef.current?.click()}
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border border-line bg-subtle hover:bg-surface text-[11px] font-medium text-ink transition active:scale-95 cursor-pointer"
                title={t('Attach Photo or Video')}
              >
                <Image class="size-3 text-emerald-600" />
                <span>{t('Attach')}</span>
              </button>
              <input
                ref={mediaInputRef}
                type="file"
                accept="image/*,video/*"
                class="hidden"
                onChange={handleMediaUpload}
              />
            </div>
          </div>

          {/* Expandable URL Input Field */}
          {showAddUrl && (
            <div class="mb-2 p-2.5 rounded-xl border border-brand-500/30 bg-brand-50/20 flex items-center gap-2 animate-in fade-in">
              <input
                type="url"
                class="input text-xs flex-1 py-1 px-2.5 h-8"
                placeholder={urlType === 'website' ? t('https://yourwebsite.com or product page') : t('https://example.com/photo.jpg or video link')}
                value={inputUrl}
                onInput={(e) => setInputUrl(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAppendUrl(inputUrl, urlType === 'website' ? 'Website' : 'Media');
                  }
                }}
                autoFocus
              />
              <button
                type="button"
                class="btn-primary text-xs py-1 px-3 h-8 shrink-0 font-semibold cursor-pointer"
                onClick={() => handleAppendUrl(inputUrl, urlType === 'website' ? 'Website' : 'Media')}
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
        </div>
      </div>
    </Dialog>
  );
}
