/**
 * The development inbox: one page listing every code the API has "sent", newest first, next to
 * the accounts that can sign in. It exists so that demonstrating the app does not mean digging
 * through a terminal.
 *
 *   http://localhost:4000/dev/mail
 *
 * It is not part of the product. The module is only loaded when NODE_ENV is not production, and
 * the page refuses to render unless MAIL_DRIVER is `log` — the moment real email is configured,
 * nothing is written to disk and there is nothing here to show.
 *
 * The page carries no JavaScript: it is rendered on the server, refreshes itself with a meta tag
 * and clears with a plain form. That way the API's own content-security policy (which forbids
 * scripts) stays exactly as strict for this page as for everything else.
 */
import { Controller, Get, Header, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DbService } from '../../common/db.service';
import { loadEnv } from '../../common/env';
import { Public } from '../../common/guards';

interface DevMail { at: string; to: string; subject: string; text: string }

@Public()
@Controller('dev')
export class DevController {
  private readonly env = loadEnv();
  private readonly dir = join(resolve(this.env.STORAGE_DIR), 'mail');

  constructor(private readonly db: DbService) {}

  private get available(): boolean {
    return this.env.NODE_ENV !== 'production' && this.env.MAIL_DRIVER === 'log';
  }

  private read(limit = 60): DevMail[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, limit)
        .map((f) => JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as DevMail);
    } catch {
      return [];
    }
  }

  /** For anything that would rather read it than look at it. */
  @Get('mail.json')
  json() {
    return this.available ? this.read() : [];
  }

  /**
   * The accounts the sign-in page offers while demonstrating, with the one password they share.
   * Answers an empty list the moment this is anything but a development deployment, so the panel
   * on the sign-in page simply does not appear.
   */
  @Get('accounts')
  async accounts() {
    const password = this.env.DEV_DEMO_PASSWORD;
    if (!this.available || !password) return { accounts: [], password: '' };
    const rows = await this.db.query<{ email: string; name: string; role: string; company: string; has_password: boolean }>(
      `select p.email, p.name, p.role::text as role, coalesce(c.name, 'WeTano') as company, p.has_password
         from people p left join companies c on c.id = p.company_id
        where p.active and p.has_password and p.role != 'individual'
        order by case p.role when 'super_admin' then 0 when 'client_admin' then 1 else 2 end, p.email`,
    ).catch(() => []);
    return { password, accounts: rows };
  }

  /**
   * The code just sent to one address, so the sign-in page can show it instead of sending somebody
   * off to a terminal. Only ever the newest, and only while messages are kept on disk.
   */
  @Get('code')
  code(@Query('email') email = '') {
    if (!this.available || !email) return { code: null };
    const wanted = String(email).toLowerCase().trim();
    const mail = this.read(40).find((m) => m.to.toLowerCase() === wanted);
    if (!mail) return { code: null };
    // Ten minutes is how long a sign-in code lives; an older message is not worth offering.
    if (Date.now() - new Date(mail.at).getTime() > 10 * 60_000) return { code: null };
    return { code: mail.text.match(/\b(\d{6})\b/)?.[1] ?? null, at: mail.at, subject: mail.subject };
  }

  @Post('mail/clear')
  clear(@Res() res: Response) {
    if (this.available) rmSync(this.dir, { recursive: true, force: true });
    res.redirect(303, '/dev/mail');
  }

  @Get('mail')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async page(@Res() res: Response) {
    if (!this.available) {
      res.status(404).send(page(`<h1>Not available</h1>
        <p class="note">This page only exists while the API runs with <code>MAIL_DRIVER=log</code>
        outside production — the only time a message is kept on disk instead of being sent.</p>`, false));
      return;
    }

    const people = await this.db.query<{ email: string; role: string; name: string; company: string; has_password: boolean }>(
      `select p.email, p.role::text as role, p.name, coalesce(c.name, 'WeTano') as company, p.has_password
         from people p left join companies c on c.id = p.company_id
        order by p.role, p.email`).catch(() => []);

    const mail = this.read();
    res.send(page(`
      <h1>WeTa Snap · development inbox</h1>
      <p class="note">Nothing here is really emailed. While <code>MAIL_DRIVER=log</code>, every message
        the API sends is written to <code>storage/mail</code> and listed below, newest first. A sign-in
        code lasts 10 minutes and only works in the browser that asked for it; an invitation code lasts
        7 days. This page refreshes itself every few seconds.</p>

      <h2>Who can sign in</h2>
      <table>
        <thead><tr><th>Account</th><th>Role</th><th>Company</th><th>Sign-in</th></tr></thead>
        <tbody>${people.map((p) => `<tr>
          <td><b>${escape(p.email)}</b><br><span class="dim">${escape(p.name)}</span></td>
          <td>${role(p.role)}</td>
          <td>${escape(p.company)}</td>
          <td>${!p.has_password ? '<span class="warn">invited — needs the setup code below</span>'
            : p.role === 'staff' ? 'password only' : 'password, then a code'}</td>
        </tr>`).join('') || '<tr><td colspan="4" class="dim">No accounts yet — run <code>npm run seed</code>.</td></tr>'}</tbody>
      </table>

      <h2>Codes
        <form method="post" action="/dev/mail/clear"><button type="submit">Clear</button></form>
      </h2>
      ${mail.length ? mail.map(message).join('') : '<p class="dim">Nothing yet. Sign in as an admin, or invite somebody.</p>'}`));
  }
}

function message(m: DevMail): string {
  const code = m.text.match(/\b(\d{6})\b/)?.[1];
  const link = m.text.match(/https?:\/\/\S*#setup=\S+/)?.[0];
  return `<article>
    <header><span class="to">${escape(m.to)}</span><span class="dim">${new Date(m.at).toLocaleTimeString()}</span></header>
    <p class="subject">${escape(m.subject)}</p>
    ${code ? `<p class="code">${code}</p>` : ''}
    ${link ? `<p><a href="${escape(link)}">Open the setup link</a></p>` : ''}
    <details><summary>Full message</summary><pre>${escape(m.text)}</pre></details>
  </article>`;
}

const role = (value: string) =>
  value === 'super_admin' ? 'WeTano' : value === 'client_admin' ? 'Admin' : 'Booth staff';

const escape = (s: string) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));

/** The app's own colours, inline, so this page needs no files served alongside it. */
const page = (body: string, refresh = true) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh ? '<meta http-equiv="refresh" content="5">' : ''}
<title>WeTa Snap · development inbox</title>
<style>
  :root { color-scheme: dark; --bg:#0b1120; --card:#111c33; --line:#1e2b45; --ink:#e8edf7; --dim:#8da2c0;
          --green:#10b981; --blue:#38bdf8; --amber:#fbbf24; }
  * { box-sizing: border-box; }
  body { margin:0 auto; padding:24px 16px 56px; background:var(--bg); color:var(--ink);
         font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; max-width:760px; }
  h1 { font-size:20px; margin:0 0 6px; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim);
       margin:34px 0 12px; display:flex; align-items:center; gap:14px; }
  h2 form { margin:0; }
  .note { color:var(--dim); font-size:14px; margin:0; }
  code { background:#0f1a2e; border:1px solid var(--line); border-radius:5px; padding:1px 5px; font-size:13px; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th { text-align:left; color:var(--dim); font-weight:600; font-size:11px; text-transform:uppercase;
       letter-spacing:.06em; padding:0 10px 8px 0; }
  td { padding:10px 10px 10px 0; border-top:1px solid var(--line); vertical-align:top; }
  .dim { color:var(--dim); font-size:13px; }
  .warn { color:var(--amber); }
  article { background:var(--card); border:1px solid var(--line); border-radius:14px;
            padding:14px 16px; margin-bottom:12px; }
  article header { display:flex; justify-content:space-between; gap:12px; align-items:baseline; }
  .to { font-weight:600; color:var(--blue); word-break:break-all; }
  .subject { margin:2px 0 0; font-size:14px; color:var(--dim); }
  .code { font-size:38px; font-weight:700; letter-spacing:.22em; margin:10px 0 4px; color:var(--green);
          user-select:all; cursor:text; }
  a { color:var(--blue); word-break:break-all; }
  details { margin-top:6px; } summary { cursor:pointer; color:var(--dim); font-size:13px; }
  pre { white-space:pre-wrap; font-size:12px; color:var(--dim); background:#0f1a2e; border-radius:10px;
        padding:10px; margin:8px 0 0; }
  button { background:var(--card); color:var(--ink); border:1px solid var(--line); border-radius:999px;
           padding:5px 14px; font:inherit; font-size:12px; cursor:pointer; }
  button:hover { border-color:var(--green); }
</style></head><body>${body}</body></html>`;
