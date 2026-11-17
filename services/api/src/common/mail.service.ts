/**
 * Outgoing email: the 6-digit sign-in code, invitations, licence reminders, support replies.
 * MAIL_DRIVER=log prints the message (and the code) to the console, which is what a development
 * machine wants; MAIL_DRIVER=smtp sends it through SMTP_URL.
 *
 * Every message is plain HTML with no tracking and no remote images.
 */
import { Injectable, Logger } from '@nestjs/common';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTransport, type Transporter } from 'nodemailer';
import { loadEnv } from './env';

export interface Mail { to: string; subject: string; html: string; fromName?: string }

@Injectable()
export class MailService {
  private readonly log = new Logger('Mail');
  private readonly env = loadEnv();
  private transport: Transporter | null = null;

  private get smtp(): Transporter {
    if (!this.transport) {
      this.transport = createTransport({
        url: this.env.SMTP_URL!,
        pool: true,
        maxConnections: 3,
        connectionTimeout: 8000,
        greetingTimeout: 5000,
        socketTimeout: 10000,
      } as any);
    }
    return this.transport;
  }

  async send(mail: Mail): Promise<{ sent: boolean; error?: string }> {
    const fromAddr = address(this.env.MAIL_FROM);
    const fromName = mail.fromName || 'WeTano Support';
    const from = `"${fromName.replace(/"/g, '')}" <${fromAddr}>`;
    if (this.env.MAIL_DRIVER === 'log' || !this.env.SMTP_URL) {
      this.log.log(`\n  ── email ──────────────────────────────────────────────\n  to:      ${mail.to}\n  subject: ${mail.subject}\n${text(mail.html).split('\n').map((l) => `  ${l}`).join('\n')}\n  ───────────────────────────────────────────────────────`);
      this.keep(mail);
      return { sent: true };
    }
    try {
      await this.smtp.sendMail({ from, to: mail.to, subject: mail.subject, html: mail.html, text: text(mail.html) });
      return { sent: true };
    } catch (e) {
      const error = (e as Error).message;
      this.log.error(`could not send "${mail.subject}" to ${mail.to}: ${error}`);
      return { sent: false, error };
    }
  }

  /**
   * Development only: each message is also dropped in <STORAGE_DIR>/mail as JSON, so a code can be
   * picked up without scrolling the console — and so the integration tests can read one.
   */
  private keep(mail: Mail): void {
    if (this.env.NODE_ENV === 'production') return;
    try {
      const dir = join(resolve(this.env.STORAGE_DIR), 'mail');
      mkdirSync(dir, { recursive: true });
      const name = `${Date.now()}-${mail.to.replace(/[^\w.@-]/g, '_')}.json`;
      writeFileSync(join(dir, name), JSON.stringify({
        at: new Date().toISOString(), to: mail.to, subject: mail.subject, text: text(mail.html),
      }, null, 2));
    } catch {
      // A development convenience must never break sending.
    }
  }

  // ---------------------------------------------------------------- templates
  signInCode(name: string, code: string): Mail['html'] {
    return layout(`
      <p>Hello ${escapeHtml(name || 'there')},</p>
      <p>Your WeTa Snap sign-in code is:</p>
      ${bigCode(code)}
      <p>It is valid for 10 minutes and only works on the device where you just entered your password.
      If this was not you, someone knows your password: change it now and tell your admin.</p>`);
  }

  passwordCode(name: string, code: string, setup: boolean): Mail['html'] {
    return layout(`
      <p>Hello ${escapeHtml(name || 'there')},</p>
      <p>${setup ? 'To choose your WeTa Snap password, enter this code' : 'Your WeTa Snap password reset code is'}:</p>
      ${bigCode(code)}
      <p>It is valid for 10 minutes. If you did not ask for this, you can ignore this email — nothing has changed.</p>`);
  }

  /** AUTH-08: the invitation carries the code and the button, so setting up is one visit. */
  invitation(company: string, name: string, link: string, code: string, endsOn: string | null): Mail['html'] {
    return layout(`
      <p>Hello ${escapeHtml(name || 'there')},</p>
      <p><strong>${escapeHtml(company)}</strong> has invited you to WeTa Snap, the business-card scanner for exhibitions.</p>
      <p>Setting up takes a minute.${code ? ' Your code is:' : ''}</p>
      ${code ? bigCode(code) : ''}
      <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#047857;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Set up password</a></p>
      <p>The button opens WeTa Snap and asks for the code above, then for the password you want to use.
      The code is valid for 7 days — if it has run out, the same screen can send you a new one.
      After that you sign in with your email address and that password.</p>
      ${endsOn ? `<p>Your access is valid until ${escapeHtml(endsOn)}.</p>` : ''}
      <p style="color:#64748b;font-size:13px">Tip: on your phone, add the app to your home screen after signing in.
      If you did not expect this invitation, you can ignore this email.</p>`);
  }

  licenceReminder(company: string, days: number, endsOn: string): Mail['html'] {
    return layout(`
      <p>Hello,</p>
      <p>The WeTa Snap licence for <strong>${escapeHtml(company)}</strong> ${days > 0
        ? `ends in ${days} day${days === 1 ? '' : 's'}, on ${escapeHtml(endsOn)}.`
        : `ended on ${escapeHtml(endsOn)}.`}</p>
      <p>Scanning keeps working for two weeks after the end date; after that the app is read-only
      until the licence is renewed. Reply to this email and we will sort it out.</p>`);
  }

  supportReply(number: string, subject: string, body: string): Mail['html'] {
    return layout(`
      <p>There is a new reply on your support request <strong>${escapeHtml(number)}</strong> — ${escapeHtml(subject)}:</p>
      <blockquote style="margin:16px 0;padding:12px 16px;border-left:3px solid #047857;background:#f8fafc">${escapeHtml(body).replace(/\n/g, '<br>')}</blockquote>
      <p>Open Support in WeTa Snap to answer.</p>`);
  }
}

const address = (from: string) => from.match(/<([^>]+)>/)?.[1] ?? from;

const layout = (inner: string) => `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;line-height:1.5">
${inner}
<p style="color:#64748b;font-size:13px;margin-top:24px">Never share a code from this email. WeTano will never ask you for one.</p>
</div>`;

const bigCode = (code: string) =>
  `<p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:16px 0">${escapeHtml(code)}</p>`;

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));

const text = (html: string) => html.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').trim();
