// Builds docs/wireframe/index.html from the screenshots in docs/testing/screens.
// Run: node docs/wireframe/build.mjs  (after `npx playwright test visual` in apps/web)
import { readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, '..', 'testing', 'screens');

const PORTALS = [
  { id: 'public', title: 'Before sign-in', path: '/signin', intro: 'Two doors: the WeTano Console has its own address, client admins and staff share the main one. The password comes first; admins then get a 6-digit emailed code. An authenticator is never required — only accounts that turn one on in Security are asked for it. Where a person lands afterwards comes from their account, not from the page they signed in on.' },
  { id: 'super-admin', title: 'Super Admin portal', path: '/super-admin/companies, /super-admin/usage, …', intro: 'WeTano staff only. Runs every customer company: licences, plans and invoices, usage limits, the audit log, support, and the security policy that applies across the whole app.' },
  { id: 'client-admin', title: 'Client Admin portal', path: '/leads, /team, /settings, …', intro: 'A customer company’s admin. Sees all the company’s leads, manages the team and events, sets up fields, tags, CRM and billing, and can scan like staff.' },
  { id: 'staff', title: 'Staff portal', path: '/scan, /my-leads', intro: 'The people at the booth. Scan a card, check the reading, add notes by voice and save. It works offline and sends when there is a connection. Staff only ever see their own leads.' },
];

// Screen order, title, route and what it is for. Keys match the screenshot file names.
const SCREENS = {
  public: [
    ['signin', 'Sign in', '/signin  ·  /super-admin/signin', 'The shared page for companies, and the Console’s own. The password comes first; what follows depends on the account.'],
    ['signin-emailed-code', 'Emailed 6-digit code', '/signin', 'Step 2 for admins: the code sent to their email. Can be resent after 30 seconds.'],
    ['signin-setup', 'First-time setup', '/signin#setup=<email>', 'Where the invitation email leads: the 6-digit code from it, a new password and the same password again, then Go to sign in.'],
    ['signin-forgot', 'Forgot password', '/signin', 'Enter the email and a reset code is sent.'],
    ['signin-reset', 'Reset password', '/signin', 'Code and new password, checked live against the password policy.'],
  ],
  'super-admin': [
    ['companies', 'Companies', '/super-admin/companies', 'Home. Search with a filter button (status incl. Suspended, plan). The licence column shows plan · Monthly/Annual.'],
    ['new-company', 'New company', 'sheet', 'Name, country, admin, plan and licence type.'],
    ['company-detail', 'Company detail', 'sheet', 'Admin names and emails, plan above licence type, seats, scan-limit action (block / overage / notify), suspend.'],
    ['subscriptions-subs', 'Subscriptions', '/super-admin/subscriptions · Subscriptions tab', 'Search with a filter button, tick boxes for bulk actions, Excel export.'],
    ['subscriptions-plans', 'Plans', '/super-admin/subscriptions · Plans tab', 'The plan catalogue: price, seats, scans per month, connectors.'],
    ['subscriptions-invoices', 'Invoices', '/super-admin/subscriptions · Invoices tab', 'Search with a filter button, multi-select, Excel export, download each invoice as a PDF.'],
    ['new-invoice', 'New invoice', 'sheet', 'Numbered automatically; final once issued.'],
    ['invoice-sheet', 'Invoice', 'sheet', 'Mark paid, void, download.'],
    ['usage', 'Usage', '/super-admin/usage', 'Scans, AI reads and seats per company, against the plan.'],
    ['usage-alerts', 'Usage alerts', '/super-admin/usage · Usage alerts tab', 'Thresholds that raise a notification once per period.'],
    ['audit', 'Audit log', '/super-admin/audit', 'Every change and every error: the action, the error name, the root cause and where it happened. Has an “Errors only” filter.'],
    ['audit-detail', 'Audit entry', 'sheet', 'The full detail of one entry.'],
    ['support', 'Support', '/super-admin/support', 'Tickets from every company; assign and close.'],
    ['security-policy', 'Security: policy', '/super-admin/security', 'Password rules, lockout, idle timeout and device-session length for the whole app.'],
    ['security-account', 'Security: my account', '/super-admin/security?tab=account', 'Password change (verified by email), authenticator, recovery codes.'],
    ['security-devices', 'Security: active sessions', '/super-admin/security?tab=devices', 'Every signed-in device with its IP address; revoke.'],
    ['security-history', 'Security: sign-in history', '/super-admin/security?tab=history', 'Successful and failed sign-ins, with IP address and device.'],
    ['notifications', 'Notifications', 'dropdown', 'The bell in the header, with tabs for All, Unread and Reminders. Each item opens its screen.'],
    ['profile', 'My profile', '/super-admin/profile', 'Picture, name, phone, theme, language, app version.'],
    ['menu', 'Account menu', 'dropdown', 'Profile, security, theme and sign-out (always asks yes/no).'],
  ],
  'client-admin': [
    ['leads', 'Leads', '/leads', 'Home. Search with the filter button beside it, sorting, and tick boxes for bulk tag, resend, export and delete.'],
    ['leads-filters', 'Lead filters', 'sheet', 'Events and captured-by (multi-select), tags, status, interest, and dates including Last 30 days.'],
    ['lead-preview', 'Lead preview', 'sheet', 'Read-only until Edit is tapped. Tap to call, mail, open the website or the map. Save to device, share.'],
    ['lead-edit', 'Lead edit', 'sheet', 'After Edit: every field, tags, notes (voice too), interest.'],
    ['import', 'Import leads', 'sheet', 'Excel or CSV. Map the columns and pick the event and tags; duplicates are flagged.'],
    ['import-history', 'Import history', 'sheet', 'Past imports. “View imported leads” filters the list to one file.'],
    ['scan', 'Scan', '/scan', 'The same capture screen staff use.'],
    ['my-leads', 'My leads', '/my-leads', 'The admin’s own captures.'],
    ['team', 'Team', '/team', 'Filters for role, status and events; seats used.'],
    ['invite-dialog', 'Invite a person', 'sheet', 'Name, email, phone, role, events (multi-select).'],
    ['invite-sent', 'Invitation sent', 'sheet', 'What they were emailed: a 6-digit code and a Set up password button, plus the setup link to pass on by hand.'],
    ['settings-company', 'Settings: company', '/settings?tab=company', 'Headquarters, default language, time zone, consent text, retention.'],
    ['settings-events', 'Settings: events', '/settings', 'Dates, description, time zone, template, attachments.'],
    ['settings-fields', 'Settings: card fields', '/settings?tab=fields', 'The default template plus the company’s own templates.'],
    ['settings-tags', 'Settings: tags', '/settings?tab=tags', 'Tag names and colours.'],
    ['settings-crm', 'Settings: CRM', '/settings?tab=crm', 'The connectors the plan allows.'],
    ['settings-billing', 'Settings: billing & plan', '/settings?tab=billing', 'Plan, seats, scans this month, invoices.'],
    ['security', 'Security', '/security', 'Password, optional authenticator, recovery codes, sessions, history.'],
    ['support', 'Support', '/support', 'The company’s requests to WeTano.'],
    ['support-new-request', 'New support request', 'sheet', 'Subject, category, message.'],
    ['notifications', 'Notifications', 'dropdown', 'The bell, with reminders.'],
    ['profile', 'My profile', '/profile', 'Picture, details, theme, app version.'],
    ['menu', 'Account menu', 'dropdown', 'Profile, security, theme, sign-out.'],
  ],
  staff: [
    ['scan', 'Scan', '/scan', 'Home. Photograph the front and back of the card; the reading appears for checking.'],
    ['scan-crop', 'Crop / adjust', 'overlay', 'The photo just taken, with the card selected. Drag the corners, rotate, or tap Use photo — everything happens on the device.'],
    ['scan-review', 'Check and save', '/scan', 'Fields read from the card, tags, voice notes, interest, consent. Save to device, share.'],
    ['my-leads', 'My leads', '/my-leads', 'Only the person’s own leads, showing what is still waiting to send.'],
    ['my-leads-filters', 'My leads: filters', 'sheet', 'Event, tags, status, date.'],
    ['lead-preview', 'Lead preview', 'sheet', 'Read-only until Edit is tapped; tap to call, mail or open the map.'],
    ['lead-edit', 'Lead edit', 'sheet', 'Edit, or delete (restorable for 30 days).'],
    ['security', 'Security', '/security', 'Password change, sign-in history.'],
    ['security-devices', 'Security: devices', '/security?tab=devices', 'Signed-in devices; revoke.'],
    ['notifications', 'Notifications', 'dropdown', 'Reminders and messages from the admin.'],
    ['profile', 'My profile', '/profile', 'Picture, details, theme, app version.'],
    ['menu', 'Account menu', 'dropdown', 'Profile, security, theme, sign-out.'],
    ['signout-dialog', 'Sign out?', 'dialog', 'Always asks yes/no, and warns if anything has not been sent yet.'],
  ],
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const keyOf = (f) => f.replace(/-(phone|laptop)-(light|dark)\.png$/, '');
let total = 0;

const sections = PORTALS.map((p) => {
  const files = new Set(readdirSync(join(shots, p.id)));
  const listed = new Set(SCREENS[p.id].map((s) => s[0]));
  // Anything captured but not described above still appears, at the end.
  const extra = [...new Set([...files].map(keyOf))].filter((k) => !listed.has(k)).sort()
    .map((k) => [k, k.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()), '', '']);
  const list = [...SCREENS[p.id], ...extra].filter(([k]) => [...files].some((f) => keyOf(f) === k));
  const cards = list.map(([k, title, route, note], i) => {
    total++;
    const img = (dev) => ['light', 'dark'].map((th) => files.has(`${k}-${dev}-${th}.png`)
      ? `<img loading="lazy" class="shot ${th}" src="../testing/screens/${p.id}/${k}-${dev}-${th}.png" alt="${esc(title)}, ${dev}, ${th} theme">` : '').join('');
    return `<article class="screen" id="${p.id}-${k}">
  <header><span class="num">${String(i + 1).padStart(2, '0')}</span><div><h3>${esc(title)}</h3>${route ? `<code>${esc(route)}</code>` : ''}</div></header>
  ${note ? `<p>${esc(note)}</p>` : ''}
  <div class="frames"><figure class="phone">${img('phone')}</figure><figure class="laptop">${img('laptop')}</figure></div>
</article>`;
  }).join('\n');
  const toc = list.map(([k, title]) => `<a href="#${p.id}-${k}">${esc(title)}</a>`).join('');
  return `<section class="portal" id="${p.id}"><div class="portal-head"><h2>${esc(p.title)}</h2><code>${p.path}</code></div>
<p class="intro">${esc(p.intro)}</p><nav class="toc" aria-label="${esc(p.title)} screens">${toc}</nav>
${cards}</section>`;
}).join('\n');

const rows = [['Super Admin', 'password → emailed code → authenticator', 'Companies', 20], ['Client Admin', 'password → emailed code → (authenticator)', 'Leads', 100], ['Staff', 'password', 'Scan', 180]];
const flow = `<svg viewBox="0 0 880 250" role="img" aria-label="Sign-in flow: portal chooser, then each portal's sign-in steps, then its home screen">
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 10 5 0 10z" fill="currentColor"/></marker></defs>
<g class="node"><rect x="10" y="100" width="130" height="50" rx="10"/><text x="75" y="130">Portal chooser</text></g>
${rows.map(([n, steps, home, y]) => `<path class="edge" d="M140 125 C170 125 170 ${y + 25} 200 ${y + 25}" marker-end="url(#arrow)"/>
<g class="node"><rect x="200" y="${y}" width="150" height="50" rx="10"/><text x="275" y="${y + 23}">${n}</text><text class="sub" x="275" y="${y + 39}">sign-in</text></g>
<path class="edge" d="M350 ${y + 25} H400" marker-end="url(#arrow)"/>
<g class="step"><rect x="400" y="${y}" width="250" height="50" rx="10"/><text x="525" y="${y + 30}">${steps}</text></g>
<path class="edge" d="M650 ${y + 25} H700" marker-end="url(#arrow)"/>
<g class="home"><rect x="700" y="${y}" width="170" height="50" rx="10"/><text x="785" y="${y + 23}">${home}</text><text class="sub" x="785" y="${y + 39}">home screen</text></g>`).join('\n')}
</svg>`;

const DARK = '--bg:#0d1512;--surface:#15201b;--ink:#e6efe9;--muted:#9fb0a8;--line:#26332d;--brand:#22c55e;--brand-ink:#4ade80;--ocean:#7dd3fc;--ocean-bg:#0c2a3a;color-scheme:dark';

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>WeTa Snap Wireframe</title>
<style>
:root{--bg:#f6f8f7;--surface:#fff;--ink:#11201a;--muted:#5b6b64;--line:#dfe6e2;--brand:#16a34a;--brand-ink:#0f7a37;--ocean:#0369a1;--ocean-bg:#e0f2fe;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${DARK}}}
:root[data-theme=dark]{${DARK}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:28px;margin:0 0 4px;letter-spacing:-.01em}h1 span{color:var(--brand)}
.lead{color:var(--muted);max-width:70ch;margin:0 0 20px}
.bar{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);margin:0 -16px 24px;padding:10px 16px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--surface)}
.seg button{border:0;background:none;color:var(--ink);font:inherit;padding:0 14px;min-height:44px;cursor:pointer}
.seg button[aria-pressed=true]{background:var(--ocean-bg);color:var(--ocean);font-weight:600}
.jump{display:flex;gap:4px;flex-wrap:wrap;margin-left:auto}
.jump a{color:var(--brand-ink);text-decoration:none;font-weight:600;padding:10px;border-radius:8px}.jump a:hover{background:var(--surface)}
.flow{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:32px;overflow-x:auto}
.flow svg{width:100%;min-width:640px;height:auto;color:var(--muted);font-size:13px}
.flow text{text-anchor:middle;fill:var(--ink);font-weight:600}.flow text.sub{font-weight:400;fill:var(--muted);font-size:11px}
.flow .node rect{fill:var(--surface);stroke:var(--line)}
.flow .step rect{fill:var(--ocean-bg)}.flow .step text{fill:var(--ocean);font-weight:500}
.flow .home rect{fill:color-mix(in srgb,var(--brand) 14%,var(--surface));stroke:var(--brand)}
.flow .edge{fill:none;stroke:currentColor;stroke-width:1.5}
.portal{margin-top:40px}.portal-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}.portal-head h2{margin:0;font-size:22px}
code{font:12px ui-monospace,Consolas,monospace;color:var(--muted)}
.intro{color:var(--muted);max-width:75ch}
.toc{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 20px}
.toc a{font-size:13px;color:var(--ink);text-decoration:none;border:1px solid var(--line);background:var(--surface);border-radius:999px;padding:4px 10px}
.screen{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:16px;scroll-margin-top:72px}
.screen header{display:flex;gap:12px;align-items:flex-start}.num{font-weight:700;color:var(--brand-ink);font-variant-numeric:tabular-nums}
.screen h3{margin:0;font-size:16px}.screen p{margin:6px 0 12px;color:var(--muted)}
.frames{display:flex;gap:16px;align-items:flex-start}figure{margin:0}
.frames .phone{flex:0 0 240px}.frames .laptop{flex:1;min-width:0}
.shot{display:none;width:100%;height:auto;border:1px solid var(--line);border-radius:10px;background:var(--bg)}
body[data-shots=light] .shot.light,body[data-shots=dark] .shot.dark{display:block}
body[data-dev=phone] .frames .laptop,body[data-dev=laptop] .frames .phone{display:none}
body[data-dev=phone] .frames .phone{flex-basis:320px}
@media (max-width:720px){.frames{flex-direction:column}.frames .phone{flex:none;width:min(100%,300px)}.jump{display:none}.seg button{padding:0 10px}}
</style></head>
<body data-shots="light" data-dev="both"><div class="wrap">
<h1>WeTa <span>Snap</span> wireframe</h1>
<p class="lead">Every screen of the three portals on a phone (390 px) and a laptop (1366 px), in the light and dark themes: ${total} screens in all. They were captured from the running demo build, so this is exactly what the app shows today.</p>
<div class="bar">
  <div class="seg" role="group" aria-label="Screenshot theme"><button data-shots="light" aria-pressed="true">Light</button><button data-shots="dark" aria-pressed="false">Dark</button></div>
  <div class="seg" role="group" aria-label="Device"><button data-dev="both" aria-pressed="true">Both</button><button data-dev="phone" aria-pressed="false">Phone</button><button data-dev="laptop" aria-pressed="false">Laptop</button></div>
  <nav class="jump" aria-label="Portals">${PORTALS.map((p) => `<a href="#${p.id}">${esc(p.title.replace(' portal', ''))}</a>`).join('')}</nav>
</div>
<h2 style="font-size:18px;margin:0 0 10px">How people get in</h2>
<div class="flow">${flow}</div>
${sections}
<p style="color:var(--muted);margin-top:40px">© ${new Date().getFullYear()} WeTano Solutions · generated by docs/wireframe/build.mjs</p>
</div>
<script>
for (const b of document.querySelectorAll('.seg button')) b.addEventListener('click', () => {
  const key = b.dataset.shots ? 'shots' : 'dev';
  document.body.dataset[key] = b.dataset[key];
  for (const x of b.parentElement.children) x.setAttribute('aria-pressed', String(x === b));
});
</script></body></html>
`;
writeFileSync(join(here, 'index.html'), html);
console.log(`wrote docs/wireframe/index.html with ${total} screens`);
