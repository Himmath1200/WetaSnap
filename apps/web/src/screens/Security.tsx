import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import {
  Check, Clock, Copy, Download, KeyRound, Laptop, MapPin, Monitor, ShieldAlert, ShieldCheck, ShieldOff,
  Smartphone, Tablet, Trash2, X,
} from 'lucide-preact';
import { Dialog, Empty, Field, Spinner, Switch, Tabs } from '../components/ui';
import { backend, isDemo } from '../lib/backend';
import { toast, useStore } from '../lib/store';
import { refreshSession, session } from '../lib/session';
import { checkPassword, passwordStrength, STRENGTH_LABEL } from '../lib/password';
import { t, tn } from '../lib/i18n';
import type { DeviceSession, LoginEvent, LoginMethod, RecoveryCodes, SecurityPolicy } from '../lib/types';

/** Security — account protection for everyone, plus the application-wide rules for WeTano (AUTH-03, PRIV-04). */

type Tab = 'policy' | 'account' | 'devices' | 'history';

const METHOD_LABEL: Record<LoginMethod, string> = {
  code: 'Emailed code',
  password: 'Password',
  totp: 'Authenticator app',
  recovery: 'Recovery code',
};

const when = (iso: string) => new Date(iso).toLocaleString();
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
/** Short enough for a tile: the time for today, otherwise the date. */
const shortWhen = (iso: string) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? t('Today {time}', { time: clock(iso) }) : `${day(iso)} · ${clock(iso)}`;
};

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('Copied'), 'success');
  } catch {
    toast(t('Could not copy — select the text and copy it by hand.'), 'error');
  }
}

/** A settings line: what it does on the left, the control on the right, aligned down the card. */
function Row({ label, hint, for: htmlFor, children }: { label: string; hint?: string; for?: string; children: ComponentChildren }) {
  return (
    <div class="flex items-center justify-between gap-4 py-3">
      <div class="min-w-0">
        <label class="block text-sm font-semibold" for={htmlFor}>{label}</label>
        {hint && <p class="mt-0.5 text-xs text-muted">{hint}</p>}
      </div>
      <div class="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/** Numbers are short — a narrow box with its unit beside it reads better than a full-width field. */
function Num({ id, value, onChange, min, max, unit }: {
  id: string; value: number; onChange: (n: number) => void; min: number; max: number; unit?: string;
}) {
  return (
    <>
      <input id={id} type="number" min={min} max={max} class="input w-20 text-right tabular-nums sm:w-24"
        value={value} onInput={(e) => onChange(Number(e.currentTarget.value))} />
      <span class="w-14 text-xs text-muted">{unit ?? ''}</span>
    </>
  );
}

/** A read-only summary of the account's security — the tabs below are the way to act on it. */
function Tile({ icon, label, value, tone = 'plain' }: {
  icon: ComponentChildren; label: string; value: string; tone?: 'plain' | 'good' | 'warn';
}) {
  const ring = tone === 'good' ? 'text-brand-700 bg-brand-50' : tone === 'warn' ? 'text-amber-800 bg-amber-50' : 'text-ocean-700 bg-ocean-50';
  return (
    <div class="card flex min-h-16 items-center gap-3 p-3">
      <span class={`flex size-9 shrink-0 items-center justify-center rounded-xl ${ring}`}>{icon}</span>
      <span class="min-w-0">
        <span class="block text-xs leading-tight font-semibold text-muted">{label}</span>
        <span class="block text-sm leading-tight font-bold">{value}</span>
      </span>
    </div>
  );
}

export default function Security() {
  const s = useStore(session);
  const isSuper = s?.person.role === 'super_admin';
  const [tab, setTab] = useState<Tab>(() => {
    const asked = new URLSearchParams(location.search).get('tab') as Tab | null;
    const allowed: Tab[] = isSuper ? ['policy', 'account', 'devices', 'history'] : ['account', 'devices', 'history'];
    return asked && allowed.includes(asked) ? asked : isSuper ? 'policy' : 'account';
  });

  // Devices and history are loaded once here: the tiles above the tabs need them, and the tabs reuse them.
  const [devices, setDevices] = useState<DeviceSession[] | null>(null);
  const [history, setHistory] = useState<LoginEvent[] | null>(null);
  const loadDevices = useCallback(async () => {
    try { setDevices(await (await backend()).sessions()); }
    catch (e) { setDevices([]); toast((e as Error).message, 'error'); }
  }, []);
  const loadHistory = useCallback(async () => {
    try { setHistory(await (await backend()).loginHistory()); }
    catch (e) { setHistory([]); toast((e as Error).message, 'error'); }
  }, []);
  useEffect(() => { void loadDevices(); void loadHistory(); }, [loadDevices, loadHistory]);

  const items = useMemo(() => [
    ...(isSuper ? [{ id: 'policy' as Tab, label: t('Policy') }] : []),
    { id: 'account' as Tab, label: t('This account') },
    { id: 'devices' as Tab, label: t('Devices') },
    { id: 'history' as Tab, label: t('Sign-in history') },
  ], [isSuper]);

  const mfaOn = Boolean(s?.person.mfa_enabled);
  const week = Date.now() - 7 * 86_400_000;
  const failed = (history ?? []).filter((r) => !r.ok && new Date(r.at).getTime() > week).length;
  const lastOk = (history ?? []).find((r) => r.ok);

  return (
    <div class="mx-auto w-full max-w-6xl">
      <div class="mb-4">
        <h1 class="text-xl font-bold">{t('Security')}</h1>
        <p class="text-sm text-muted">{t('Passwords, two-factor, the devices you are signed in on and every sign-in attempt.')}</p>
      </div>

      <div class="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile icon={mfaOn ? <ShieldCheck class="size-5" /> : <ShieldOff class="size-5" />}
          tone={mfaOn ? 'good' : 'warn'} label={t('Two-factor')} value={mfaOn ? t('On') : t('Off')} />
        <Tile icon={<Laptop class="size-5" />} label={t('Signed-in devices')}
          value={devices ? String(devices.length) : '—'} />
        <Tile icon={<ShieldAlert class="size-5" />} tone={failed > 0 ? 'warn' : 'plain'}
          label={t('Failed sign-ins')} value={history ? t('{n} in 7 days', { n: failed }) : '—'} />
        <Tile icon={<Clock class="size-5" />} label={t('Last sign-in')}
          value={lastOk ? shortWhen(lastOk.at) : '—'} />
      </div>

      <Tabs<Tab> value={tab} onChange={setTab} items={items} />

      <div class="mt-5">
        {tab === 'policy' && isSuper && <PolicyTab />}
        {tab === 'account' && <AccountTab />}
        {tab === 'devices' && <DevicesTab rows={devices} reload={loadDevices} />}
        {tab === 'history' && <HistoryTab rows={history} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- policy (Super Admin)
/** A password that satisfies the rules as they stand — shown so the numbers mean something. */
function workedExample(p: SecurityPolicy) {
  let pw = p.require_upper ? 'Harbour' : 'harbour';
  pw += p.require_symbol ? '-lantern' : ' lantern';
  if (p.require_number) pw += '47';
  while (pw.length < p.min_length) pw += p.require_symbol ? '-blue' : 'blue';
  return pw;
}

function PolicyTab() {
  const [p, setP] = useState<SecurityPolicy | null>(null);
  const [saved, setSaved] = useState<SecurityPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<SecurityPolicy>) => setP((prev) => (prev ? { ...prev, ...patch } : prev));

  useEffect(() => {
    backend().then((b) => b.securityPolicy()).then((x) => { setP(x); setSaved(x); })
      .catch((e) => toast((e as Error).message, 'error'));
  }, []);

  async function save() {
    if (!p) return;
    setBusy(true);
    try {
      const out = await (await backend()).saveSecurityPolicy(p);
      setP(out); setSaved(out);
      toast(t('Security rules saved'), 'success');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  }

  if (!p) return <div class="flex justify-center py-16"><Spinner class="size-6 text-brand-700" /></div>;

  const example = workedExample(p);
  const problems = checkPassword(example, p);
  const dirty = JSON.stringify(p) !== JSON.stringify(saved);

  return (
    <div class="space-y-4">
      <p class="rounded-2xl bg-ocean-50 px-4 py-3 text-sm text-ocean-800">
        {t('These rules apply to every account in the application — WeTano, client admins and staff alike.')}
      </p>

      <div class="grid items-start gap-4 lg:grid-cols-2">
        <section class="card p-4">
          <h2 class="title font-bold">{t('Passwords')}</h2>
          <div class="mt-1 divide-y divide-line">
            <Row label={t('Minimum length')} for="sp-len">
              <Num id="sp-len" min={6} max={64} value={p.min_length} onChange={(n) => set({ min_length: n })} unit={t('characters')} />
            </Row>
            <Row label={t('Password expires after')} hint={t('0 = passwords never expire.')} for="sp-exp">
              <Num id="sp-exp" min={0} max={730} value={p.expiry_days} onChange={(n) => set({ expiry_days: n })} unit={t('days')} />
            </Row>
            <Row label={t('Old passwords blocked')} hint={t('How many previous passwords may not be used again.')} for="sp-reuse">
              <Num id="sp-reuse" min={0} max={24} value={p.reuse_block} onChange={(n) => set({ reuse_block: n })} />
            </Row>
            <div class="space-y-2 pt-3">
              <Switch on={p.require_upper} onChange={(v) => set({ require_upper: v })} label={t('Require a capital letter')} />
              <Switch on={p.require_number} onChange={(v) => set({ require_number: v })} label={t('Require a number')} />
              <Switch on={p.require_symbol} onChange={(v) => set({ require_symbol: v })} label={t('Require a symbol')} hint={t('For example ! # or -')} />
            </div>
          </div>
          <p class={`mt-3 rounded-xl px-3 py-2 text-sm ${problems.length === 0 ? 'bg-brand-50 text-brand-800' : 'bg-amber-50 text-amber-800'}`}>
            {problems.length === 0
              ? t('A password like {example} would be accepted.', { example })
              : t('With these rules even {example} would be refused: {why}', { example, why: problems.map((x) => t(x)).join(' ') })}
          </p>
        </section>

        <div class="space-y-4">
          <section class="card p-4">
            <h2 class="title font-bold">{t('Sign-in and sessions')}</h2>
            <div class="mt-1 divide-y divide-line">
              <Row label={t('Wrong attempts before lock-out')} for="sp-att">
                <Num id="sp-att" min={1} max={20} value={p.lockout_attempts} onChange={(n) => set({ lockout_attempts: n })} unit={t('tries')} />
              </Row>
              <Row label={t('Locked out for')} for="sp-lock">
                <Num id="sp-lock" min={1} max={1440} value={p.lockout_minutes} onChange={(n) => set({ lockout_minutes: n })} unit={t('minutes')} />
              </Row>
              <Row label={t('Signed out after idle')} hint={t('0 = never signed out for being idle.')} for="sp-idle">
                <Num id="sp-idle" min={0} max={1440} value={p.idle_timeout_minutes} onChange={(n) => set({ idle_timeout_minutes: n })} unit={t('minutes')} />
              </Row>
              <Row label={t('Device stays signed in')} hint={t('After this, the person signs in again on that device.')} for="sp-dev">
                <Num id="sp-dev" min={1} max={365} value={p.device_session_days} onChange={(n) => set({ device_session_days: n })} unit={t('days')} />
              </Row>
            </div>
          </section>

          <section class="card space-y-2 p-4">
            <h2 class="title font-bold">{t('Two-factor')}</h2>
            <p class="text-sm text-muted">
              {t('An authenticator app is never required. Anyone who wants one can turn it on for their own account under “This account”, and is then asked for it at every sign-in.')}
            </p>
          </section>
        </div>
      </div>

      {/* Stays in view while the rules are being changed — on phones it clears the bottom bar. */}
      <div class={`flex flex-wrap items-center gap-3 border-line bg-surface px-4 py-3 ${dirty
        ? 'sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-10 -mx-4 border-t md:bottom-0 md:mx-0 md:rounded-2xl md:border'
        : 'rounded-2xl border'}`}>
        <p class="text-sm font-semibold text-muted">{dirty ? t('Unsaved changes') : t('Everything is saved')}</p>
        <div class="ml-auto flex gap-2">
          {dirty && <button class="btn-ghost" disabled={busy} onClick={() => setP(saved)}>{t('Undo changes')}</button>}
          <button class="btn-primary" disabled={busy} onClick={() => void save()}>{busy ? <Spinner /> : t('Save security rules')}</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- this account
function AccountTab() {
  const [policy, setPolicy] = useState<SecurityPolicy | null>(null);
  useEffect(() => { backend().then((b) => b.securityPolicy()).then(setPolicy).catch(() => {}); }, []);

  return (
    <div class="grid items-start gap-4 lg:grid-cols-2">
      <ChangePassword policy={policy} />
      <TwoFactor />
    </div>
  );
}

function ChangePassword({ policy }: { policy: SecurityPolicy | null }) {
  const [step, setStep] = useState<'current' | 'code'>('current');
  const [current, setCurrent] = useState('');
  const [code, setCode] = useState('');
  const [demoCode, setDemoCode] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const problems = policy ? checkPassword(pw, policy) : [];
  const strength = passwordStrength(pw);
  const strengthCls = ['bg-red-500', 'bg-red-500', 'bg-amber-400', 'bg-ocean-500', 'bg-brand-500'][strength] ?? 'bg-subtle';

  async function askCode() {
    setErr('');
    if (!current) { setErr(t('Enter your current password.')); return; }
    setBusy(true);
    try {
      const { demoCode: dc } = await (await backend()).requestPasswordChange(current);
      setDemoCode(dc ?? '');
      setStep('code');
      toast(t('We emailed you a 6-digit code.'), 'success');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function confirm() {
    setErr('');
    if (!/^\d{6}$/.test(code)) { setErr(t('Enter the 6-digit code from the email.')); return; }
    if (problems.length > 0) { setErr(t(problems[0]!)); return; }
    setBusy(true);
    try {
      await (await backend()).confirmPasswordChange(code, pw);
      toast(t('Password changed'), 'success');
      setStep('current'); setCurrent(''); setCode(''); setPw(''); setDemoCode('');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <section class="card space-y-3 p-4">
      <header class="flex items-center gap-2">
        <span class="flex size-9 items-center justify-center rounded-xl bg-ocean-50 text-ocean-700"><KeyRound class="size-5" /></span>
        <h2 class="title font-bold">{t('Change password')}</h2>
      </header>
      <p class="text-sm text-muted">{t('We email a 6-digit code to confirm the change, so a password cannot be changed by someone using your open screen.')}</p>

      {step === 'current' ? (
        <>
          <Field label={t('Current password')} for="cp-cur">
            <input id="cp-cur" type="password" autocomplete="current-password" class="input" value={current} onInput={(e) => setCurrent(e.currentTarget.value)} />
          </Field>
          {err && <p class="text-sm font-medium text-red-700">{err}</p>}
          <button class="btn-primary w-full sm:w-auto" disabled={busy} onClick={() => void askCode()}>{busy ? <Spinner /> : t('Send confirmation code')}</button>
        </>
      ) : (
        <>
          {isDemo && demoCode && (
            <p class="rounded-xl bg-ocean-50 px-3 py-2 text-sm text-ocean-800">{t('Demo mode — your code is {code}', { code: demoCode })}</p>
          )}
          <div class="grid gap-3 sm:grid-cols-2">
            <Field label={t('6-digit code')} for="cp-code">
              <input id="cp-code" inputMode="numeric" maxLength={6} autocomplete="one-time-code" class="input tracking-[0.3em]" value={code} onInput={(e) => setCode(e.currentTarget.value.replace(/\D/g, ''))} />
            </Field>
            <Field label={t('New password')} for="cp-new">
              <input id="cp-new" type="password" autocomplete="new-password" class="input" value={pw} onInput={(e) => setPw(e.currentTarget.value)} />
            </Field>
          </div>

          <div>
            <div class="h-1.5 w-full overflow-hidden rounded-full bg-subtle" role="progressbar" aria-valuenow={strength} aria-valuemin={0} aria-valuemax={4} aria-label={t('Password strength')}>
              <span class={`block h-full rounded-full transition-all ${strengthCls}`} style={{ width: `${(strength / 4) * 100}%` }} />
            </div>
            <p class="mt-1 text-xs font-semibold text-muted">{t(STRENGTH_LABEL[strength] ?? 'Weak')}</p>
          </div>

          {pw.length > 0 && (
            <ul class="space-y-1 text-xs">
              {problems.length === 0
                ? <li class="flex items-center gap-1.5 font-medium text-brand-700"><Check class="size-3.5" />{t('This password meets every rule.')}</li>
                : problems.map((x) => <li key={x} class="flex items-center gap-1.5 font-medium text-amber-800"><X class="size-3.5" />{t(x)}</li>)}
            </ul>
          )}

          {err && <p class="text-sm font-medium text-red-700">{err}</p>}
          <div class="flex flex-wrap gap-2">
            <button class="btn-primary" disabled={busy} onClick={() => void confirm()}>{busy ? <Spinner /> : t('Change password')}</button>
            <button class="btn-ghost" disabled={busy} onClick={() => { setStep('current'); setCode(''); setPw(''); setErr(''); }}>{t('Cancel')}</button>
          </div>
        </>
      )}
    </section>
  );
}

function TwoFactor() {
  const s = useStore(session);
  const [on, setOn] = useState(Boolean(s?.person.mfa_enabled));
  const [enrol, setEnrol] = useState<{ secret: string; otpauth_url: string } | null>(() => {
    try {
      const saved = localStorage.getItem('wetasnap_mfa_enrol');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<RecoveryCodes | null>(null);
  const [fresh, setFresh] = useState(false);
  const [askOff, setAskOff] = useState(false);
  const [offCode, setOffCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { setOn(Boolean(s?.person.mfa_enabled)); }, [s?.person.mfa_enabled]);

  async function start() {
    setErr(''); setBusy(true);
    try {
      const data = await (await backend()).startMfaEnrolment();
      setEnrol(data);
      try { localStorage.setItem('wetasnap_mfa_enrol', JSON.stringify(data)); } catch {}
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function confirm() {
    setErr('');
    if (!/^\d{6}$/.test(code)) { setErr(t('Enter the 6-digit code from your authenticator app.')); return; }
    setBusy(true);
    try {
      const rc = await (await backend()).confirmMfaEnrolment(code);
      setCodes(rc); setFresh(true); setEnrol(null); setCode(''); setOn(true);
      try { localStorage.removeItem('wetasnap_mfa_enrol'); } catch {}
      void refreshSession();
      toast(t('Two-factor is on'), 'success');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function showCodes() {
    setErr(''); setBusy(true);
    try { setCodes(await (await backend()).recoveryCodes()); setFresh(false); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function regenerate() {
    setErr(''); setBusy(true);
    try {
      setCodes(await (await backend()).regenerateRecoveryCodes());
      setFresh(true);
      toast(t('New recovery codes made — the old ones no longer work.'), 'success');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function turnOff() {
    setErr('');
    if (!/^\d{6}$/.test(offCode)) { setErr(t('Enter the 6-digit code from your authenticator app.')); return; }
    setBusy(true);
    try {
      await (await backend()).disableMfa(offCode);
      setOn(false); setCodes(null); setAskOff(false); setOffCode('');
      void refreshSession();
      toast(t('Two-factor is off'), 'success');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  function downloadCodes(list: string[]) {
    const blob = new Blob([`${t('WeTa Snap recovery codes')}\n\n${list.join('\n')}\n`], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'wetasnap-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <section class="card space-y-3 p-4">
      <header class="flex flex-wrap items-center gap-2">
        <span class={`flex size-9 items-center justify-center rounded-xl ${on ? 'bg-brand-50 text-brand-700' : 'bg-subtle text-muted'}`}>
          {on ? <ShieldCheck class="size-5" /> : <ShieldOff class="size-5" />}
        </span>
        <h2 class="title font-bold">{t('Two-factor')}</h2>
        <span class={`pill ml-auto ${on ? 'bg-brand-100 text-brand-800' : 'bg-subtle text-muted'}`}>{on ? t('On') : t('Off')}</span>
      </header>
      <p class="text-sm text-muted">{t('An authenticator app gives a fresh 6-digit code every 30 seconds. Even someone who knows your password cannot sign in without it.')}</p>

      {!on && !enrol && (
        <button class="btn-secondary w-full sm:w-auto" disabled={busy} onClick={() => void start()}>{busy ? <Spinner /> : t('Set up two-factor')}</button>
      )}

      {enrol && (
        <div class="space-y-3">
          <p class="text-sm">{t('Add this secret to your authenticator app by hand, then type the code it shows.')}</p>
          <div>
            <span class="label">{t('Secret')}</span>
            <div class="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-subtle px-3 py-2">
              <code class="min-w-0 flex-1 font-mono text-sm break-all">{enrol.secret}</code>
              <button class="btn-secondary min-h-11 px-3" onClick={() => void copyText(enrol.secret)}><Copy class="size-4" />{t('Copy')}</button>
            </div>
          </div>
          <div>
            <span class="label">{t('Set-up link')}</span>
            <div class="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-subtle px-3 py-2">
              <code class="min-w-0 flex-1 font-mono text-xs break-all">{enrol.otpauth_url}</code>
              <button class="btn-secondary min-h-11 px-3" onClick={() => void copyText(enrol.otpauth_url)}><Copy class="size-4" />{t('Copy')}</button>
            </div>
          </div>
          <Field label={t('Code from the app')} for="mfa-code">
            <input id="mfa-code" inputMode="numeric" maxLength={6} autocomplete="one-time-code" class="input tracking-[0.3em]" value={code} onInput={(e) => setCode(e.currentTarget.value.replace(/\D/g, ''))} />
          </Field>
          <div class="flex flex-wrap gap-2">
            <button class="btn-primary" disabled={busy} onClick={() => void confirm()}>{busy ? <Spinner /> : t('Turn on two-factor')}</button>
            <button class="btn-ghost" disabled={busy} onClick={() => { setEnrol(null); setCode(''); setErr(''); try { localStorage.removeItem('wetasnap_mfa_enrol'); } catch {} }}>{t('Cancel')}</button>
          </div>
        </div>
      )}

      {codes && (
        <div class="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
          <p class="text-sm font-semibold text-amber-900">{fresh ? t('Save these recovery codes now — they are shown once.') : t('Your recovery codes')}</p>
          <p class="text-xs text-amber-800">{tn(codes.codes.length - codes.used, '{n} code left', '{n} codes left', { n: codes.codes.length - codes.used })} · {t('made {date}', { date: new Date(codes.generated_at).toLocaleDateString() })}</p>
          <ul class="grid grid-cols-2 gap-1 font-mono text-sm">
            {codes.codes.map((c) => <li key={c} class="rounded bg-surface px-2 py-1 text-center">{c}</li>)}
          </ul>
          <div class="flex flex-wrap gap-2">
            <button class="btn-secondary min-h-11 px-3" onClick={() => void copyText(codes.codes.join('\n'))}><Copy class="size-4" />{t('Copy')}</button>
            <button class="btn-secondary min-h-11 px-3" onClick={() => downloadCodes(codes.codes)}><Download class="size-4" />{t('Download')}</button>
            <button class="btn-ghost min-h-11 px-3" onClick={() => setCodes(null)}>{t('Hide')}</button>
          </div>
        </div>
      )}

      {on && (
        <div class="flex flex-wrap gap-2">
          {!codes && <button class="btn-secondary min-h-11 px-3" disabled={busy} onClick={() => void showCodes()}>{t('Show recovery codes')}</button>}
          <button class="btn-secondary min-h-11 px-3" disabled={busy} onClick={() => void regenerate()}>{t('Make new recovery codes')}</button>
          <button class="btn-danger min-h-11 px-3" disabled={busy} onClick={() => setAskOff(true)}>{t('Turn off two-factor')}</button>
        </div>
      )}

      {err && <p class="text-sm font-medium text-red-700">{err}</p>}

      <Dialog open={askOff} onClose={() => { setAskOff(false); setOffCode(''); }} title={t('Turn off two-factor')}
        footer={<>
          <button class="btn-ghost" onClick={() => { setAskOff(false); setOffCode(''); }}>{t('Cancel')}</button>
          <button class="btn-danger" disabled={busy} onClick={() => void turnOff()}>{busy ? <Spinner /> : t('Turn it off')}</button>
        </>}>
        <div class="space-y-3">
          <p class="text-sm">{t('Your account will be protected by its password alone. Type a code from your authenticator app to confirm.')}</p>
          <Field label={t('Code from the app')} for="mfa-off">
            <input id="mfa-off" inputMode="numeric" maxLength={6} autocomplete="one-time-code" class="input tracking-[0.3em]" value={offCode} onInput={(e) => setOffCode(e.currentTarget.value.replace(/\D/g, ''))} />
          </Field>
        </div>
      </Dialog>
    </section>
  );
}

// ---------------------------------------------------------------- devices
/** A phone, a tablet and a laptop should not all look the same in the list. */
function deviceIcon(name: string) {
  const n = name.toLowerCase();
  if (/iphone|android|phone|pixel|galaxy/.test(n)) return <Smartphone class="size-5" />;
  if (/ipad|tablet/.test(n)) return <Tablet class="size-5" />;
  if (/mac|windows|linux|chromebook/.test(n)) return <Laptop class="size-5" />;
  return <Monitor class="size-5" />;
}

/** One fact of a device or sign-in: the label above, the value below, so columns line up. */
function Fact({ label, value, icon, wide }: { label: string; value: string; icon?: ComponentChildren; wide?: boolean }) {
  if (!value) return null;
  return (
    <div class={`min-w-0 ${wide ? 'col-span-2 sm:col-span-1' : ''}`}>
      <p class="text-[11px] font-semibold text-muted uppercase">{label}</p>
      <p class="flex items-start gap-1 text-xs break-words text-ink">{icon}{value}</p>
    </div>
  );
}

function DevicesTab({ rows, reload }: { rows: DeviceSession[] | null; reload: () => Promise<void> }) {
  const [one, setOne] = useState<DeviceSession | null>(null);
  const [askAll, setAskAll] = useState(false);
  const [busy, setBusy] = useState(false);

  async function revoke() {
    if (!one) return;
    setBusy(true);
    try {
      await (await backend()).revokeSession(one.id);
      toast(t('{device} was signed out', { device: one.device }), 'success');
      setOne(null);
      await reload();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  }

  async function revokeAll() {
    setBusy(true);
    try {
      await (await backend()).revokeOtherSessions();
      toast(t('Every other device was signed out'), 'success');
      setAskAll(false);
      await reload();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  }

  const others = (rows ?? []).filter((r) => !r.current).length;

  return (
    <div class="space-y-4">
      <div class="card overflow-hidden">
        <header class="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
          <div class="min-w-0">
            <h2 class="title font-bold">{t('Signed-in devices')}</h2>
            <p class="text-xs text-muted">{t('Every phone, tablet and computer signed in to this account. Sign out anything you do not recognise.')}</p>
          </div>
          {others > 0 && (
            <button class="btn-danger ml-auto w-full sm:w-auto" onClick={() => setAskAll(true)}>{t('Sign out all other devices')}</button>
          )}
        </header>

        {!rows ? <div class="flex justify-center py-16"><Spinner class="size-6 text-brand-700" /></div>
          : rows.length === 0 ? <Empty icon={<Laptop class="size-6" />} title={t('No devices')} text={t('Devices appear here as soon as you sign in on them.')} />
          : (
            <ul class="divide-y divide-line">
              {rows.map((r) => (
                <li key={r.id} class="px-4 py-3">
                  <div class="flex flex-wrap items-start gap-3">
                    <span class={`flex size-10 shrink-0 items-center justify-center rounded-xl ${r.current ? 'bg-brand-50 text-brand-700' : 'bg-subtle text-muted'}`}>
                      {deviceIcon(r.device)}
                    </span>
                    <div class="min-w-[12rem] flex-1">
                      <p class="flex flex-wrap items-center gap-2 text-sm font-semibold">
                        {r.device}
                        {r.current && <span class="pill bg-brand-100 text-brand-800">{t('This device')}</span>}
                      </p>
                      <div class="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                        <Fact wide label={t('Where from')} value={[r.location, r.ip].filter(Boolean).join(' · ')} icon={<MapPin class="mt-0.5 size-3 shrink-0 text-muted" />} />
                        <Fact label={t('First seen')} value={when(r.created_at)} />
                        <Fact label={t('Last seen')} value={when(r.last_seen_at)} />
                      </div>
                    </div>
                    {!r.current && (
                      <button class="btn-danger w-full shrink-0 px-3 sm:w-auto" onClick={() => setOne(r)}><Trash2 class="size-4" />{t('Sign out')}</button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
      </div>

      <Dialog open={Boolean(one)} onClose={() => setOne(null)} title={t('Sign out this device')}
        footer={<>
          <button class="btn-ghost" onClick={() => setOne(null)}>{t('Cancel')}</button>
          <button class="btn-danger" disabled={busy} onClick={() => void revoke()}>{busy ? <Spinner /> : t('Sign it out')}</button>
        </>}>
        <p class="text-sm">{t('{device} will have to sign in again. Anything it has not synced yet is kept on that device.', { device: one?.device ?? '' })}</p>
      </Dialog>

      <Dialog open={askAll} onClose={() => setAskAll(false)} title={t('Sign out all other devices')}
        footer={<>
          <button class="btn-ghost" onClick={() => setAskAll(false)}>{t('Cancel')}</button>
          <button class="btn-danger" disabled={busy} onClick={() => void revokeAll()}>{busy ? <Spinner /> : t('Sign them all out')}</button>
        </>}>
        <p class="text-sm">{tn(others, '{n} other device will have to sign in again. This device stays signed in.', '{n} other devices will have to sign in again. This device stays signed in.', { n: others })}</p>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------- sign-in history
const PAGE = 25;

function HistoryTab({ rows }: { rows: LoginEvent[] | null }) {
  const [failedOnly, setFailedOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const all = (rows ?? []).filter((r) => !failedOnly || !r.ok);
  const shown = all.slice(0, limit); // a phone should not scroll through a year of sign-ins
  const failed = (rows ?? []).filter((r) => !r.ok).length;

  return (
    <div class="space-y-4">
      <div class="card overflow-hidden">
        <header class="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
          <div class="min-w-0">
            <h2 class="title font-bold">{t('Sign-in history')}</h2>
            <p class="text-xs text-muted">{t('Every sign-in attempt, successful or not. Failed attempts are in red.')}</p>
          </div>
          <div class="ml-auto flex gap-1 rounded-xl border border-line p-1">
            {[[false, t('All')], [true, t('Failed only')]].map(([v, label]) => (
              <button key={String(v)} aria-pressed={failedOnly === v} onClick={() => { setFailedOnly(v as boolean); setLimit(PAGE); }}
                class={`min-h-11 rounded-lg px-3 text-sm font-semibold transition ${failedOnly === v ? 'bg-ocean-50 text-ocean-800' : 'text-muted hover:text-ink'}`}>
                {label}{v && failed > 0 ? ` · ${failed}` : ''}
              </button>
            ))}
          </div>
        </header>

        {!rows ? <div class="flex justify-center py-16"><Spinner class="size-6 text-brand-700" /></div>
          : shown.length === 0 ? <Empty icon={<ShieldCheck class="size-6" />} title={failedOnly ? t('No failed attempts') : t('Nothing yet')} text={failedOnly ? t('Nobody has been refused on this account.') : t('Sign-in attempts appear here.')} />
          : (
            <>
              <table class="hidden w-full text-sm md:table">
                <thead class="bg-subtle text-left text-xs font-semibold text-muted uppercase">
                  <tr>
                    <th class="px-4 py-2.5 whitespace-nowrap">{t('When')}</th>
                    <th class="px-4 py-2.5">{t('Email')}</th>
                    <th class="px-4 py-2.5 whitespace-nowrap">{t('Method')}</th>
                    <th class="px-4 py-2.5">{t('Result')}</th>
                    <th class="px-4 py-2.5">{t('Device')}</th>
                    <th class="px-4 py-2.5">{t('Where from')}</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-line">
                  {shown.map((r) => (
                    <tr key={r.id} class={r.ok ? '' : 'bg-red-50/60'}>
                      <td class="px-4 py-3 whitespace-nowrap tabular-nums">{when(r.at)}</td>
                      <td class="px-4 py-3 font-medium">{r.email}</td>
                      <td class="px-4 py-3 whitespace-nowrap">{t(METHOD_LABEL[r.method])}</td>
                      <td class="px-4 py-3">
                        <span class={`pill ${r.ok ? 'bg-brand-100 text-brand-800' : 'bg-red-100 text-red-700'}`}>{r.ok ? t('Signed in') : t(r.reason) || t('Failed')}</span>
                      </td>
                      <td class="px-4 py-3 text-muted">{r.device}</td>
                      <td class="px-4 py-3 text-muted">{[r.location, r.ip].filter(Boolean).join(' · ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <ul class="divide-y divide-line md:hidden">
                {shown.map((r) => (
                  <li key={r.id} class={`px-4 py-3 ${r.ok ? '' : 'bg-red-50/60'}`}>
                    <div class="flex items-start gap-3">
                      <span class={`mt-1 size-2.5 shrink-0 rounded-full ${r.ok ? 'bg-brand-500' : 'bg-red-500'}`} />
                      <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-baseline justify-between gap-x-2">
                          <span class="truncate text-sm font-semibold">{r.email}</span>
                          <span class="text-xs text-muted tabular-nums">{when(r.at)}</span>
                        </div>
                        <p class={`text-xs font-semibold ${r.ok ? 'text-brand-700' : 'text-red-700'}`}>
                          {r.ok ? t('Signed in') : (t(r.reason) || t('Failed'))}
                        </p>
                        <div class="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
                          <Fact label={t('Method')} value={t(METHOD_LABEL[r.method])} />
                          <Fact label={t('Device')} value={r.device} />
                          <Fact wide label={t('Where from')} value={[r.location, r.ip].filter(Boolean).join(' · ')} icon={<MapPin class="mt-0.5 size-3 shrink-0 text-muted" />} />
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
              <div class="flex flex-wrap items-center gap-3 border-t border-line px-4 py-2">
                <p class="text-xs text-muted">
                  {all.length > shown.length
                    ? t('Showing {shown} of {total}', { shown: shown.length, total: all.length })
                    : failedOnly ? tn(shown.length, '{n} failed attempt', '{n} failed attempts') : tn(shown.length, '{n} attempt', '{n} attempts')}
                </p>
                {all.length > shown.length && (
                  <button class="btn-ghost ml-auto px-3 text-sm" onClick={() => setLimit((n) => n + PAGE)}>{t('Show more')}</button>
                )}
              </div>
            </>
          )}
      </div>
    </div>
  );
}
