import type { Company, Lead } from './types';

export interface FollowUpConfig {
  autoSend: boolean;
  sendWhatsApp: boolean;
  sendEmail: boolean;
  message: string;
  senderCompanyName?: string;
  attachmentUrl?: string;
  websiteUrl?: string;
}

export const DEFAULT_FOLLOWUP_MESSAGE = `Hi {name}, it was great meeting you at {event}! Thank you for connecting with {sender} from {company}. Looking forward to staying in touch.`;

export function getFollowUpConfig(personId: string, company?: Company | null, isStaff = false): FollowUpConfig {
  let cfg: FollowUpConfig = {
    autoSend: false,
    sendWhatsApp: true,
    sendEmail: true,
    message: DEFAULT_FOLLOWUP_MESSAGE,
    senderCompanyName: '',
    attachmentUrl: '',
    websiteUrl: '',
  };

  // If this user belongs to a company, read company-level message template first
  if (company) {
    // 1. Check local company cache
    try {
      const coRaw = localStorage.getItem(`wetasnap_company_followup_${company.id}`);
      if (coRaw) {
        const coParsed = JSON.parse(coRaw);
        if (coParsed.message) cfg.message = coParsed.message;
        if (typeof coParsed.autoSend === 'boolean') cfg.autoSend = coParsed.autoSend;
        if (coParsed.senderCompanyName) cfg.senderCompanyName = coParsed.senderCompanyName;
        if (coParsed.attachmentUrl) cfg.attachmentUrl = coParsed.attachmentUrl;
        if (coParsed.websiteUrl) cfg.websiteUrl = coParsed.websiteUrl;
      }
    } catch {}

    // 2. Authoritative server company object overrides local cache
    if (company.follow_up_message) {
      cfg.message = company.follow_up_message;
    }
    if (typeof company.follow_up_auto === 'boolean') {
      cfg.autoSend = company.follow_up_auto;
    }
    cfg.senderCompanyName = company.name;
  }

  // Personal preferences (or solo individual / organizer preferences)
  try {
    const raw = localStorage.getItem(`wetasnap_followup_${personId}`);
    if (raw) {
      const p = JSON.parse(raw);
      // For staff members in a company, the company message template is strictly enforced, but channel preferences remain personal
      if (company && isStaff) {
        cfg.sendWhatsApp = p.sendWhatsApp ?? cfg.sendWhatsApp;
        cfg.sendEmail = p.sendEmail ?? cfg.sendEmail;
      } else {
        cfg = { ...cfg, ...p };
      }
    }
  } catch {}

  return cfg;
}

export function saveFollowUpConfig(personId: string, cfg: FollowUpConfig, companyId?: string | null) {
  try {
    localStorage.setItem(`wetasnap_followup_${personId}`, JSON.stringify(cfg));
    if (companyId) {
      localStorage.setItem(`wetasnap_company_followup_${companyId}`, JSON.stringify(cfg));
    }
  } catch {}
}

export function formatFollowUpMessage(
  template: string,
  lead: { fields: Lead['fields'] },
  senderName: string,
  eventName?: string,
  companyName?: string,
  attachmentUrl?: string,
  websiteUrl?: string,
): string {
  const name = lead.fields.full_name?.value || lead.fields.first_name?.value || 'there';
  const leadComp = lead.fields.company?.value || lead.fields.company_name?.value || '';
  const event = eventName || 'the event';
  const myCompany = companyName || 'our team';

  let text = (template || DEFAULT_FOLLOWUP_MESSAGE)
    .replace(/\{name\}/gi, name)
    .replace(/\{company\}/gi, myCompany)
    .replace(/\{lead_company\}/gi, leadComp)
    .replace(/\{event\}/gi, event)
    .replace(/\{sender\}/gi, senderName);

  if (websiteUrl && !text.includes(websiteUrl)) {
    text += `\n\nWebsite: ${websiteUrl}`;
  }
  if (attachmentUrl && !text.includes(attachmentUrl)) {
    text += `\n\nView attachment: ${attachmentUrl}`;
  }

  return text;
}

export async function shareViaNativeSheet(
  title: string,
  text: string,
  files?: File[],
): Promise<boolean> {
  if (typeof navigator === 'undefined') return false;
  try {
    if (files && files.length > 0 && navigator.canShare?.({ files })) {
      await navigator.share({ title, text, files });
      return true;
    }
    if (navigator.share) {
      await navigator.share({ title, text });
      return true;
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') {
      console.warn('[Share] Share sheet failed, falling back:', err);
    }
  }
  return false;
}

export function sendViaWhatsApp(phone: string, text: string): boolean {
  const digits = phone.replace(/\D/g, '');
  if (!digits || digits.length < 7) return false;
  // If standard 10-digit number without country code, prefix with 91
  const cleanPhone = digits.length === 10 ? `91${digits}` : digits;
  const url = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(text)}`;
  if (typeof window !== 'undefined') {
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isMobile) {
      window.location.href = url;
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }
  return true;
}

export function sendViaEmail(email: string, subject: string, body: string): boolean {
  const clean = email.trim();
  if (!clean || !clean.includes('@')) return false;
  const url = `mailto:${encodeURIComponent(clean)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.location.href = url;
  return true;
}
