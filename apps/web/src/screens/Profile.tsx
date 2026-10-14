import { useEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import {
  Camera, Globe, LogOut, Mail, Monitor, Moon, Phone, ShieldCheck, Smartphone, Sun, Trash2, Upload,
} from 'lucide-preact';
import { Avatar, Dialog, Field, Spinner, Switch } from '../components/ui';
import { backend } from '../lib/backend';
import { useStore, toast } from '../lib/store';
import { endSession, refreshSession, session } from '../lib/session';
import { unsyncedCount } from '../lib/db';
import { syncNow } from '../lib/sync';
import { isOnline } from '../lib/net';
import { applyTheme, theme, type ThemePref } from '../lib/theme';
import { enablePush, disablePush, pushState, supportsPush } from '../lib/notifications';
import { LANGUAGES } from '../lib/locale';
import { APP_VERSION, BUILD_DATE } from '../lib/version';
import { doorForRole, linkFor, signInPath } from '../lib/portal';
import { t } from '../lib/i18n';


/** My profile — picture, contact details, appearance, this app's version, and signing out. */
export default function Profile() {
  const s = useStore(session)!;
  const cur = useStore(theme);
  const push = useStore(pushState);
  const { route } = useLocation();
  const [name, setName] = useState(s.person.name);
  const [phone, setPhone] = useState(s.person.phone);
  const [busy, setBusy] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [confirmOut, setConfirmOut] = useState<null | { waiting: number }>(null);
  const file = useRef<HTMLInputElement>(null);


  useEffect(() => { setName(s.person.name); setPhone(s.person.phone); }, [s.person.id]);

  async function save() {
    setBusy(true);
    try {
      await (await backend()).updateProfile({ name, phone });
      await refreshSession();
      toast(t('Profile saved'), 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function pickAvatar(f: File | undefined | null) {
    setAvatarBusy(true);
    try {
      await (await backend()).saveAvatar(f ?? null);
      await refreshSession();
      toast(f ? t('Picture updated') : t('Picture removed'), 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setAvatarBusy(false);
    }
  }

  async function askSignOut() {
    setConfirmOut({ waiting: await unsyncedCount() });
  }

  async function doSignOut() {
    await endSession();
    setConfirmOut(null);
    route(signInPath(doorForRole(s.person.role)));
  }

  const themes: { id: ThemePref; label: string; icon: typeof Sun }[] = [
    { id: 'light', label: 'Light', icon: Sun },
    { id: 'dark', label: 'Dark', icon: Moon },
    { id: 'system', label: 'System', icon: Monitor },
  ];

  return (
    <div class="mx-auto w-full max-w-6xl">
      <h1 class="mb-4 text-xl font-bold">{t('My profile')}</h1>

      <section class="card mb-4 p-4">
        <div class="flex items-center gap-4">
          <span class="relative">
            {s.person.avatar_url
              ? <img src={s.person.avatar_url} alt="" class="size-16 rounded-full border border-line object-cover" />
              : <Avatar name={s.person.name} size="size-16 text-lg" />}
            <button class="absolute -right-3 -bottom-3 flex size-11 items-center justify-center rounded-full" aria-hidden="false"
              onClick={() => file.current?.click()} aria-label={t('Change picture')}>
              <span class="flex size-7 items-center justify-center rounded-full border border-line bg-surface text-ocean-700 shadow-sm">
                {avatarBusy ? <Spinner class="size-3.5" /> : <Camera class="size-3.5" />}
              </span>
            </button>
          </span>
          <div class="min-w-0 flex-1">
            <p class="truncate font-bold">{s.person.name}</p>
            <p class="truncate text-sm text-muted">{s.person.email}</p>
            <p class="mt-1 flex flex-wrap items-center gap-2">
              <span class="pill bg-brand-50 text-brand-800">
                {s.person.role === 'super_admin' ? t('WeTano Super Admin') : s.person.role === 'client_admin' ? t('Client Admin') : t('Staff')}
              </span>
              {s.company && <span class="text-xs text-muted">{s.company.name}</span>}
            </p>
          </div>
        </div>
        <div class="mt-3 flex flex-wrap gap-2">
          <button class="btn-secondary min-h-10 px-3 text-xs" onClick={() => file.current?.click()}><Upload class="size-4" />{t('Upload a picture')}</button>
          {s.person.avatar_url && <button class="btn-ghost min-h-10 px-3 text-xs text-red-700" onClick={() => void pickAvatar(null)}><Trash2 class="size-4" />{t('Remove')}</button>}
          <span class="self-center text-[11px] text-muted">{t('A square picture under 2 MB works best.')}</span>
        </div>
        <input ref={file} type="file" accept="image/*" class="hidden" onChange={(e) => { void pickAvatar(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
      </section>

      <section class="card mb-4 space-y-3 p-4">
        <h2 class="title text-sm font-bold">{t('Your details')}</h2>
        <div class="grid gap-3 sm:grid-cols-2">
          <Field label={t('Name')} for="pf-name"><input id="pf-name" class="input" value={name} onInput={(e) => setName(e.currentTarget.value)} /></Field>
          <Field label={t('Mobile number')} for="pf-phone">
            <div class="relative">
              <Phone class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
              <input id="pf-phone" type="tel" inputMode="tel" class="input pl-9" value={phone} placeholder="+49 151 2345678" onInput={(e) => setPhone(e.currentTarget.value)} />
            </div>
          </Field>
        </div>
        <Field label={t('Email')} for="pf-email" hint={t('Your email is your sign-in — ask WeTano to change it.')}>
          <div class="relative">
            <Mail class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
            <input id="pf-email" class="input pl-9" value={s.person.email} disabled />
          </div>
        </Field>
        <button class="btn-primary w-full sm:w-auto" disabled={busy} onClick={() => void save()}>{busy ? <Spinner /> : t('Save')}</button>
      </section>

      <section class="card mb-4 space-y-3 p-4">
        <h2 class="title text-sm font-bold">{t('Appearance')}</h2>
        <div class="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t('Appearance')}>
          {themes.map((i) => (
            <button key={i.id} role="radio" aria-checked={cur === i.id} onClick={() => applyTheme(i.id)}
              class={`flex flex-col items-center gap-1 rounded-xl border px-2 py-2.5 text-xs font-semibold transition ${cur === i.id ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line text-slate-600 hover:bg-subtle'}`}>
              <i.icon class="size-4" />{t(i.label)}
            </button>
          ))}
        </div>
        <Field label={t('Language')} for="pf-lang" hint={t('German and French arrive in Phase 2.')}>
          <div class="relative">
            <Globe class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
            <select id="pf-lang" class="input pl-9" disabled>
              {LANGUAGES.slice(0, 1).map((l) => <option key={l.id}>{l.label}</option>)}
            </select>
          </div>
        </Field>
        {supportsPush() && (
          <Switch
            on={push === 'granted'}
            onChange={(v) => void (v ? enablePush(import.meta.env.VITE_VAPID_PUBLIC_KEY ?? '') : disablePush())
              .then(() => toast(v ? t('Alerts are on for this device') : t('Alerts are off for this device'), 'success'))
              .catch((e: Error) => toast(e.message, 'error'))}
            label={t('Alert me on this device')}
            hint={t('Tells you about failed leads and reminders even when the app is closed.')}
          />
        )}
      </section>

      <section class="card mb-4 p-4">
        <h2 class="title mb-1 text-sm font-bold">{t('Security')}</h2>
        <p class="mb-3 text-xs text-muted">{t('Where you are signed in, two-factor, recovery codes and your password.')}</p>
        <div class="flex flex-wrap gap-2">
          <a href={linkFor(s.person.role, '/security')} class="btn-secondary min-h-10 px-3 text-xs"><ShieldCheck class="size-4" />{t('Security & devices')}</a>
          <a href={linkFor(s.person.role, '/security?tab=devices')} class="btn-ghost min-h-10 px-3 text-xs"><Smartphone class="size-4" />{t('Active sessions')}</a>
        </div>
      </section>

      <section class="card mb-4 p-4">
        <h2 class="title mb-2 text-sm font-bold">{t('About')}</h2>
        <dl class="grid grid-cols-2 gap-y-1 text-xs">
          <dt class="text-muted">{t('App version')}</dt><dd class="font-medium tabular-nums">{APP_VERSION}</dd>
          <dt class="text-muted">{t('Build date')}</dt><dd class="font-medium tabular-nums">{BUILD_DATE}</dd>
          <dt class="text-muted">{t('Signed in as')}</dt><dd class="truncate font-medium">{s.person.email}</dd>
        </dl>
      </section>

      <button class="btn-danger w-full" onClick={() => void askSignOut()}><LogOut class="size-4" />{t('Sign out')}</button>

      <Dialog
        open={!!confirmOut} onClose={() => setConfirmOut(null)} title={t('Sign out?')}
        footer={<>
          <button class="btn-ghost" onClick={() => setConfirmOut(null)}>{t('No, stay signed in')}</button>
          {confirmOut?.waiting
            ? <button class="btn-primary" disabled={!isOnline()} onClick={async () => { await syncNow(); const w = await unsyncedCount(); if (w === 0) await doSignOut(); else setConfirmOut({ waiting: w }); }}>{t('Sync first')}</button>
            : <button class="btn bg-red-600 text-white hover:bg-red-700" onClick={() => void doSignOut()}>{t('Yes, sign out')}</button>}
        </>}
      >
        {confirmOut?.waiting
          ? <p class="text-sm text-slate-700">{t('{n} leads are still only on this device. Signing out deletes them — sync first so nothing is lost.', { n: confirmOut.waiting })}</p>
          : <p class="text-sm text-slate-700">{t('You will need to sign in again. Leads already sent stay safe; anything else on this device is removed.')}</p>}
        {!!confirmOut?.waiting && (
          <button class="mt-3 text-xs font-semibold text-red-700 hover:underline" onClick={() => void doSignOut()}>{t('Sign out anyway and delete them')}</button>
        )}
      </Dialog>

    </div>
  );
}
