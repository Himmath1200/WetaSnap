/**
 * Prints the newest development email — in practice, the 6-digit code you are waiting for.
 *
 *   npm run mail -w @wetasnap/api           the newest message
 *   npm run mail -w @wetasnap/api -- anna   the newest one to an address containing "anna"
 *   npm run mail -w @wetasnap/api -- --all  the last ten, newest first
 *
 * With MAIL_DRIVER=log (the default) every message the API sends is also written to
 * <STORAGE_DIR>/mail as JSON. Set MAIL_DRIVER=smtp and SMTP_URL and this folder stays empty,
 * because the mail then really goes out.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const all = args.includes('--all');
const match = args.find((a) => !a.startsWith('--'));
const dir = resolve(process.env.STORAGE_DIR ?? join(import.meta.dirname, '..', 'storage'), 'mail');

let files;
try {
  files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse();
} catch {
  console.log(`\n  Nothing yet — ${dir} does not exist.\n  Start the API (npm run dev) and sign in; the message lands here.\n`);
  process.exit(0);
}

if (match) files = files.filter((f) => f.toLowerCase().includes(match.toLowerCase()));
if (!files.length) {
  console.log(`\n  No message${match ? ` to an address containing "${match}"` : ''} yet.\n`);
  process.exit(0);
}

for (const file of files.slice(0, all ? 10 : 1)) {
  const mail = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const code = mail.text.match(/\b(\d{6})\b/)?.[1];
  console.log(`\n  ${new Date(mail.at).toLocaleTimeString()}  →  ${mail.to}`);
  console.log(`  ${mail.subject}`);
  if (code) console.log(`\n      ${code}\n`);
  else console.log(`\n${mail.text.split('\n').map((l) => `      ${l}`).join('\n')}\n`);
}
