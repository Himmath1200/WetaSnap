import { useEffect, useRef, useState } from 'preact/hooks';
import { MessageSquare, Mail, Check, ArrowRight, Link, Image, FileText, Share2, X } from 'lucide-preact';
import { Dialog } from './ui';
import { t } from '../lib/i18n';
import {
  type FollowUpConfig,
  formatFollowUpMessage,
  sendViaWhatsApp,
  sendViaEmail,
  shareViaNativeSheet,
  getStoredFollowUpAttachments,
  storedToFiles,
  stripFileTagsFromText,
  downloadFile,
} from '../lib/followup';
import { toast } from '../lib/store';
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

  const initialText = stripFileTagsFromText(
    formatFollowUpMessage(config.message, lead, senderName, eventName, companyName, config.attachmentUrl, config.websiteUrl)
  );
  const [customText, setCustomText] = useState(initialText);
  const [sentWa, setSentWa] = useState(false);
  const [sentMail, setSentMail] = useState(false);
  const [sentShare, setSentShare] = useState(false);

  // Attached media files: Real images, videos, PDFs
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<{ name: string; url: string; type: string; size: string }[]>([]);

  const [inputUrl, setInputUrl] = useState('');
  const [showAddUrl, setShowAddUrl] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (lead) {
      setCustomText(
        stripFileTagsFromText(
          formatFollowUpMessage(config.message, lead, senderName, eventName, companyName, config.attachmentUrl, config.websiteUrl)
        )
      );
      setSentWa(false);
      setSentMail(false);
      setSentShare(false);
      setInputUrl('');
      setShowAddUrl(false);

      // Load default real attachments from storage
      void getStoredFollowUpAttachments().then((defaults) => {
        if (defaults.length > 0) {
          const files = storedToFiles(defaults);
          setAttachedFiles(files);
          const newPreviews = files.map((file) => {
            const url = URL.createObjectURL(file);
            const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
            const sizeStr = file.size > 1024 * 1024 ? `${sizeMb} MB` : `${Math.round(file.size / 1024)} KB`;
            return { name: file.name, url, type: file.type, size: sizeStr };
          });
          setPreviews(newPreviews);
        } else {
          setAttachedFiles([]);
          setPreviews([]);
        }
      });
    }
  }, [lead?.id, config.message, config.attachmentUrl, config.websiteUrl, senderName, eventName, companyName]);

  const handleAppendUrl = (url: string) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const formatted = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const toAppend = `\n\nLink: ${formatted}`;
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
    toast(t('Added {count} file(s) to send.', { count: newFiles.length }), 'success');
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
    const cleanMsg = stripFileTagsFromText(customText);
    const ok = await shareViaNativeSheet(title, cleanMsg, attachedFiles.length > 0 ? attachedFiles : undefined);
    if (ok) setSentShare(true);
  };

  const handleWhatsApp = async () => {
    const cleanMsg = stripFileTagsFromText(customText);

    if (attachedFiles.length > 0) {
      // 1. On mobile / supported devices, Web Share API sends real binary files directly into WhatsApp
      if (canNativeShare && navigator.canShare?.({ files: attachedFiles })) {
        try {
          const ok = await shareViaNativeSheet(leadName, cleanMsg, attachedFiles);
          if (ok) {
            setSentWa(true);
            return;
          }
        } catch {}
      }

      // 2. Desktop fallback (WhatsApp Web)
      // Copy image to clipboard for instant Ctrl+V paste into chat
      const imgFile = attachedFiles.find((f) => f.type.startsWith('image/'));
      if (imgFile && typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        try {
          await navigator.clipboard.write([new ClipboardItem({ [imgFile.type]: imgFile })]);
          toast(t('Photo copied to clipboard! In WhatsApp, press Ctrl+V to send directly.'), 'info', 5000);
        } catch {}
      }

      // Auto-download files so user can drag & drop directly into WhatsApp Web chat
      attachedFiles.forEach((f) => downloadFile(f, f.name));
      toast(t('File ready! Drag & drop or paste into WhatsApp to send directly.'), 'success', 5000);
    }

    if (!phone) {
      if (attachedFiles.length > 0 && canNativeShare) {
        await shareViaNativeSheet(leadName, cleanMsg, attachedFiles);
        setSentWa(true);
      }
      return;
    }

    sendViaWhatsApp(phone, cleanMsg);
    setSentWa(true);
  };

  const handleEmail = async () => {
    const subject = eventName ? `${eventName} — Great connecting with you!` : t('Great connecting with you!');
    const cleanMsg = stripFileTagsFromText(customText);

    if (attachedFiles.length > 0) {
      if (canNativeShare && navigator.canShare?.({ files: attachedFiles })) {
        try {
          const ok = await shareViaNativeSheet(subject, cleanMsg, attachedFiles);
          if (ok) {
            setSentMail(true);
            return;
          }
        } catch {}
      }
      attachedFiles.forEach((f) => downloadFile(f, f.name));
      toast(t('Attachment downloaded to add to email.'), 'info', 5000);
    }

    if (!email) return;
    sendViaEmail(email, subject, cleanMsg);
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
            {/* Direct File Attachment Buttons */}
            <div class="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={() => setShowAddUrl((v) => !v)}
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border border-line bg-subtle hover:bg-surface text-[11px] font-medium text-ink transition active:scale-95 cursor-pointer"
                title={t('Add Website or Link')}
              >
                <Link class="size-3 text-ocean-600" />
                <span>{t('+ Link')}</span>
              </button>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-brand-500/40 bg-brand-50 hover:bg-brand-100 text-[11px] font-semibold text-brand-700 transition active:scale-95 cursor-pointer shadow-xs"
                title={t('Attach Image, Video or PDF file')}
              >
                <Image class="size-3.5 text-brand-600" />
                <span>{t('+ Attach File (Photo/Video/PDF)')}</span>
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
                placeholder={t('https://yourwebsite.com or product link')}
                value={inputUrl}
                onInput={(e) => setInputUrl(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAppendUrl(inputUrl);
                  }
                }}
                autoFocus
              />
              <button
                type="button"
                class="btn-primary text-xs py-1 px-3 h-8 shrink-0 font-semibold cursor-pointer"
                onClick={() => handleAppendUrl(inputUrl)}
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
                  {t('Direct Files Attached ({count})', { count: previews.length })}
                </span>
                <span class="text-[10px] text-emerald-600 font-semibold">
                  {t('Sent as real files, not text links')}
                </span>
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {previews.map((item, idx) => (
                  <div key={idx} class="group relative rounded-lg border border-line bg-surface p-2 flex items-center gap-2.5 min-w-0">
                    {item.type.startsWith('image') ? (
                      <img src={item.url} alt={item.name} class="size-9 rounded-md object-cover shrink-0 border border-line/40" />
                    ) : item.type.startsWith('video') ? (
                      <div class="size-9 rounded-md bg-slate-900 text-white flex items-center justify-center shrink-0">
                        <span class="text-[9px] font-bold">VIDEO</span>
                      </div>
                    ) : (
                      <div class="size-9 rounded-md bg-rose-50 text-rose-600 flex items-center justify-center shrink-0 border border-rose-200">
                        <FileText class="size-4" />
                      </div>
                    )}
                    <div class="min-w-0 flex-1">
                      <p class="text-xs font-semibold text-ink truncate leading-tight">{item.name}</p>
                      <p class="text-[10px] text-muted">{item.size}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeFile(idx)}
                      class="size-5 rounded-full bg-slate-200 hover:bg-rose-600 hover:text-white text-muted flex items-center justify-center text-[10px] transition cursor-pointer"
                      title={t('Remove')}
                    >
                      <X class="size-3" />
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
                  <p class="text-xs font-bold truncate">
                    {attachedFiles.length > 0 ? t('WhatsApp + Files') : t('WhatsApp')}
                  </p>
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
                  <p class="text-xs font-bold truncate">
                    {attachedFiles.length > 0 ? t('Email + Files') : t('Email')}
                  </p>
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
                  <p class="text-xs font-bold truncate">{t('Share via App / Share Sheet')}</p>
                  <p class="text-[10px] text-muted truncate">
                    {attachedFiles.length > 0
                      ? t('Directly dispatches message and all {count} files', { count: attachedFiles.length })
                      : t('Open phone share sheet')}
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
