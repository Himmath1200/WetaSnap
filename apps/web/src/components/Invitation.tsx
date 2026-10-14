import { useState } from 'preact/hooks';
import { Check, Copy, MailCheck, TriangleAlert } from 'lucide-preact';
import { t } from '../lib/i18n';
import type { Invitation } from '../lib/backend';

/**
 * What an admin sees after inviting someone (AUTH-08, first-time setup of 4 Oct 2026).
 * The invited person gets an email with a 6-digit code and a “Set up password” button; this
 * says so, and hands over the same link in case the email never arrives. In the demo there is
 * no email at all, so the code is shown here — it is the only way to walk the flow through.
 */
export function InvitationNote({ email, invitation }: { email: string; invitation: Invitation }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(invitation.setup_link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div class="space-y-3">
      <div class="flex items-start gap-3 rounded-2xl bg-brand-50 p-4">
        <MailCheck class="mt-0.5 size-5 shrink-0 text-brand-700" />
        <div class="min-w-0 text-sm">
          <p class="font-semibold">
            {invitation.resent
              ? t('Invitation sent again to {email}', { email })
              : t('Invitation emailed to {email}', { email })}
          </p>
          <p class="mt-1 text-muted">
            {t('It carries a 6-digit code and a “Set up password” button. They enter the code, choose their password and sign in with it from then on. The code lasts 7 days.')}
          </p>
        </div>
      </div>

      {!invitation.email_sent && (
        <div class="flex items-start gap-3 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900">
          <TriangleAlert class="mt-0.5 size-5 shrink-0" />
          <p>{t('The email could not be sent. Pass the setup link below on yourself — it does the same thing.')}</p>
        </div>
      )}

      {invitation.demoCode && (
        <p class="rounded-2xl bg-ocean-50 px-4 py-3 text-sm text-ocean-800">
          {t('Demo mode — there is no email. Their code is')}{' '}
          <b class="font-mono tracking-widest">{invitation.demoCode}</b>
        </p>
      )}

      {invitation.setup_link && (
        <div>
          <span class="label">{t('Setup link')}</span>
          <div class="flex gap-2">
            <input class="input font-mono text-xs" readOnly value={invitation.setup_link} aria-label={t('Setup link')}
              onFocus={(e) => e.currentTarget.select()} />
            <button type="button" class="btn-secondary shrink-0 px-3" onClick={() => void copy()}>
              {copied ? <Check class="size-4" /> : <Copy class="size-4" />}
              <span class="sr-only sm:not-sr-only">{copied ? t('Copied') : t('Copy')}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
