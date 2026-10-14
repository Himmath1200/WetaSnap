import { useEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { ArrowLeft, CheckCircle2, Eye, EyeOff, KeyRound, Lock, Mail, MailCheck, ShieldCheck } from 'lucide-preact';
import { backend, isDemo } from '../lib/backend';
import { devAccounts, devCode, type DevAccounts } from '../lib/devAccounts';
import { startSession } from '../lib/session';
import { isEmail } from '../lib/validate';
import { toast } from '../lib/store';
import { DEFAULT_POLICY, STRENGTH_LABEL, checkPassword, passwordStrength } from '../lib/password';

import { t, tn } from '../lib/i18n';
import { Logo } from '../components/AppShell';
import { type Door } from '../lib/portal';
import { Copyright, Spinner } from '../components/ui';
import { homeFor } from '../routes';
import type { SecurityPolicy } from '../lib/types';

type Step = 'password' | 'email_code' | 'totp' | 'forgot' | 'setup' | 'reset' | 'done';

/**
 * S1 · Sign-in. Two doors (client decision, 26 Sep 2026): the WeTano Console at /super-admin/signin
 * and one shared page for every company account. Password first, then as many steps as the account
 * needs — nobody has to know which of them applies to them:
 *   Staff         password
 *   Client Admin  password → 6-digit emailed code → authenticator if they turned it on
 *   Super Admin   password → 6-digit emailed code → authenticator if they turned it on
 * Where they land afterwards comes from their role, not from the page they signed in on.
 *
 * First-time setup (client decision, 4 Oct 2026). Every company account is created by someone
 * else — WeTano adds the client, the client admin adds the team — and is emailed a 6-digit code
 * with a “Set up password” button pointing at /signin#setup=<address>. That opens the `setup`
 * step here: code, new password, the same password again; then “Go to sign in”. A forgotten
 * password takes the identical path (`forgot` → `reset`), so there is one flow to learn.
 */
export default function SignIn({ door }: { door: Door }) {
  const console_ = door === 'console';
  const { route } = useLocation();
  const hash = new URLSearchParams(location.hash.slice(1));
  const setupEmail = hash.get('setup'); // invitation link: the first-time setup, code in hand
  const [step, setStep] = useState<Step>(setupEmail ? 'setup' : 'password');
  const [email, setEmail] = useState(setupEmail ?? hash.get('email') ?? '');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resendIn, setResendIn] = useState(0);
  const [demoCode, setDemoCode] = useState<string | undefined>();
  /** Demo help, when the API offers it: the accounts to pick from and the code it just sent. */
  const [demo, setDemo] = useState<DevAccounts>({ password: '', accounts: [] });
  const [policy, setPolicy] = useState<SecurityPolicy>(DEFAULT_POLICY);
  const [ended] = useState(() => sessionStorage.getItem('wetasnap-ended') === '1');
  const [kept] = useState(() => Number(sessionStorage.getItem('wetasnap-kept') ?? 0));

  useEffect(() => { sessionStorage.removeItem('wetasnap-ended'); sessionStorage.removeItem('wetasnap-kept'); }, []);
  // Opening the invitation while this page is already up changes only the fragment, which no
  // browser reloads for. Follow it, or the “Set up password” button would appear to do nothing.
  useEffect(() => {
    const onHash = () => {
      const who = new URLSearchParams(location.hash.slice(1)).get('setup');
      if (!who) return;
      setEmail(who);
      setPassword('');
      setDemoCode(undefined);   // whatever was on screen belonged to the other address
      setResendIn(0);
      go('setup');
    };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => { void backend().then((b) => b.securityPolicy()).then(setPolicy).catch(() => {}); }, []);
  // A development deployment lists its own accounts; anywhere else this answers nothing and the
  // panel never appears.
  useEffect(() => { void devAccounts().then(setDemo).catch(() => {}); }, []);

  /**
   * While the code step is open on a development deployment, fetch the code that was just sent and
   * show it — so demonstrating the app never means opening a terminal or a second tab.
   */
  useEffect(() => {
    if (isDemo || !demo.password || step !== 'email_code' || demoCode) return;
    let stop = false;
    const tick = async () => {
      const code = await devCode(email);
      if (!stop && code) setDemoCode(code);
    };
    void tick();
    const h = setInterval(() => { void tick(); }, 1500);
    return () => { stop = true; clearInterval(h); };
  }, [step, email, demo.password, demoCode]);
  useEffect(() => {
    if (resendIn <= 0) return;
    const h = setTimeout(() => setResendIn((x) => x - 1), 1000);
    return () => clearTimeout(h);
  }, [resendIn]);

  const fail = (e: unknown) => setError(e instanceof Error && e.message !== 'offline' ? e.message : t('You are offline. Connect to the internet to sign in.'));
  const go = (to: Step) => { setStep(to); setError(''); };

  async function finish(si: import('../lib/backend').SignedIn) {
    await startSession(si);
    toast(t('Welcome, {name}', { name: si.person.name.split(' ')[0]! }), 'success');
    route(homeFor(si.person.role), true);
  }

  async function submitPassword(e?: Event) {
    e?.preventDefault();
    if (!isEmail(email)) { setError(t('Please enter your work email.')); return; }
    if (!password) { setError(t('Please enter your password.')); return; }
    setBusy(true); setError('');
    try {
      const r = await (await backend()).signInWithPassword(email, password, door);
      if (r.next === 'done') { await finish(r); return; }
      if (r.next === 'email_code') { setDemoCode(r.demoCode); setResendIn(30); go('email_code'); return; }
      go('totp');
    } catch (err) { fail(err); } finally { setBusy(false); }
  }

  async function submitEmailCode(code: string) {
    setBusy(true); setError('');
    try {
      const r = await (await backend()).verifyLoginCode(email, code);
      if (r.next === 'done') { await finish(r); return; }
      if (r.next === 'totp') go('totp');
    } catch (err) { fail(err); } finally { setBusy(false); }
  }

  async function submitTotp(code: string) {
    setBusy(true); setError('');
    try {
      await finish(await (await backend()).verifyTotp(email, code));
    } catch (err) { fail(err); } finally { setBusy(false); }
  }

  async function resend() {
    try {
      const r = await (await backend()).resendLoginCode(email);
      setDemoCode(r.demoCode);   // the demo panel picks the new one up on its next tick
      setResendIn(30);
    } catch (err) { fail(err); }
  }

  async function askReset(e?: Event) {
    e?.preventDefault();
    if (!isEmail(email)) { setError(t('Please enter your work email.')); return; }
    setBusy(true); setError('');
    try {
      const r = await (await backend()).requestPasswordReset(email);
      setDemoCode(r.demoCode);
      setResendIn(30);
      // On the setup step this is “Email me a new code”: stay there, the form is already open.
      if (step === 'setup') setError(''); else go('reset');
    } catch (err) { fail(err); } finally { setBusy(false); }
  }

  async function doReset(code: string, next: string) {
    setBusy(true); setError('');
    try {
      await (await backend()).resetPassword(email, code, next);
      setPassword('');
      history.replaceState(null, '', location.pathname);   // the address leaves the URL with it
      go('done');
    } catch (err) { fail(err); } finally { setBusy(false); }
  }

  const back = (to: Step) => (
    <button type="button" class="-ml-1 mb-3 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-muted hover:text-ink" onClick={() => go(to)}>
      <ArrowLeft class="size-4" />{t('Back')}
    </button>
  );

  // How many steps this account needs only becomes clear as it goes: the dots appear with step 2.
  const stepsFor = step === 'totp' ? 3 : step === 'email_code' ? 2 : 1;
  const stepNo = step === 'email_code' ? 2 : step === 'totp' ? 3 : 1;

  return (
    <div class="flex min-h-dvh flex-col items-center justify-center bg-gradient-to-br from-brand-50 via-canvas to-ocean-50 px-4 pt-[max(2rem,env(safe-area-inset-top))] pb-8 sm:pt-12 sm:pb-12">
      <div class="w-full max-w-sm">
        <div class="mb-6 flex flex-col items-center gap-3">
          <Logo />
          {console_ && (
            <span class="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-xs font-semibold text-slate-700">
              <ShieldCheck class="size-3.5 text-brand-700" />{t('WeTano Console')}
            </span>
          )}
        </div>

        <div class="card overflow-hidden">
          <div class="accent-bar" />
          <div class="p-5 sm:p-6">
            {ended && step === 'password' && (
              <p class="mb-4 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {kept > 0
                  ? tn(kept, 'You were signed out after a quiet spell. {n} lead is still safe on this phone and will be sent when you sign in again.', 'You were signed out after a quiet spell. {n} leads are still safe on this phone and will be sent when you sign in again.')
                  : t('You were signed out. Sign in again to continue.')}
              </p>
            )}
            {stepsFor > 1 && (step === 'password' || step === 'email_code' || step === 'totp') && (
              <ol class="mb-4 flex items-center gap-1.5" aria-label={t('Sign-in steps')}>
                {Array.from({ length: stepsFor }, (_, i) => (
                  <li key={i} class={`h-1.5 flex-1 rounded-full ${i < stepNo ? 'bg-brand-600' : 'bg-slate-200'}`} />
                ))}
              </ol>
            )}

            {step === 'password' && (
              <form onSubmit={submitPassword} noValidate>
                <h1 class="title text-xl font-bold">{t('Sign in')}</h1>
                <p class="mt-1 text-sm text-muted">
                  {console_ ? t('Companies, licences and support for every client.') : t('Scanning, leads and everything else — all in one place.')}
                </p>
                <label class="label mt-5" for="si-email">{t('Work email')}</label>
                <div class="relative">
                  <Mail class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
                  <input id="si-email" type="email" inputMode="email" autoComplete="username" autoFocus class="input pl-9"
                    placeholder="name@company.com" value={email} onInput={(e) => setEmail(e.currentTarget.value)} />
                </div>
                <label class="label mt-3" for="si-pw">{t('Password')}</label>
                <div class="relative">
                  <Lock class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
                  <input id="si-pw" type={showPw ? 'text' : 'password'} autoComplete="current-password" class="input pr-11 pl-9"
                    value={password} onInput={(e) => setPassword(e.currentTarget.value)} />
                  <button type="button" class="absolute top-1/2 right-0 flex size-11 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 hover:bg-subtle"
                    onClick={() => setShowPw((v) => !v)} aria-label={showPw ? t('Hide password') : t('Show password')}>
                    {showPw ? <EyeOff class="size-4" /> : <Eye class="size-4" />}
                  </button>
                </div>
                {error && <p class="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm font-medium text-red-700" role="alert">{error}</p>}
                <button type="submit" class="btn-primary mt-5 w-full" disabled={busy}>{busy ? <Spinner /> : t('Continue')}</button>
                <button type="button" class="mt-3 flex min-h-10 w-full items-center justify-center text-sm font-semibold text-ocean-700 hover:underline" onClick={() => go('forgot')}>
                  {t('Set or reset password')}
                </button>
              </form>
            )}

            {step === 'email_code' && (
              <div>
                {back('password')}
                <h1 class="title flex items-center gap-2 text-xl font-bold"><MailCheck class="size-5 text-brand-700" />{t('Check your email')}</h1>
                <p class="mt-1 text-sm text-muted">{t('We sent a 6-digit code to {email}. It lasts 10 minutes.', { email })}</p>
                {demoCode && <DemoNote>{t('Demo mode — your code is')} <b class="font-mono tracking-widest">{demoCode}</b></DemoNote>}
                <CodeBoxes key="email" disabled={busy} onComplete={(c) => void submitEmailCode(c)} />
                {error && <p class="mt-3 text-sm font-medium text-red-700" role="alert">{error}</p>}
                <div class="mt-4 flex items-center justify-between">
                  <button class="min-h-11 text-sm font-semibold text-ocean-700 disabled:text-slate-400" disabled={resendIn > 0 || busy} onClick={() => void resend()}>
                    {resendIn > 0 ? t('Resend in {s}s', { s: resendIn }) : t('Resend code')}
                  </button>
                  {busy && <Spinner class="size-5 text-brand-700" />}
                </div>
              </div>
            )}

            {step === 'totp' && (
              <div>
                {back('password')}
                <h1 class="title flex items-center gap-2 text-xl font-bold"><ShieldCheck class="size-5 text-brand-700" />
                  {t('Authenticator code')}
                </h1>
                <p class="mt-1 text-sm text-muted">{t('Enter the 6 digits from your authenticator app, or one of your recovery codes.')}</p>
                {isDemo && <DemoNote>{t('Demo mode — any 6 digits work.')}</DemoNote>}
                <CodeBoxes key="totp" disabled={busy} onComplete={(c) => void submitTotp(c)} />
                <RecoveryInput disabled={busy} onSubmit={(c) => void submitTotp(c)} />
                {error && <p class="mt-3 text-sm font-medium text-red-700" role="alert">{error}</p>}
              </div>
            )}

            {step === 'forgot' && (
              <form onSubmit={askReset} noValidate>
                {!setupEmail && back('password')}
                <h1 class="title flex items-center gap-2 text-xl font-bold"><KeyRound class="size-5 text-brand-700" />
                  {setupEmail ? t('Set your password') : t('Set or reset your password')}
                </h1>
                <p class="mt-1 text-sm text-muted">{t('We email a 6-digit code to your work address, then you choose a password.')}</p>
                <label class="label mt-5" for="fp-email">{t('Work email')}</label>
                <div class="relative">
                  <Mail class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
                  <input id="fp-email" type="email" inputMode="email" autoFocus class="input pl-9" value={email} onInput={(e) => setEmail(e.currentTarget.value)} />
                </div>
                {error && <p class="mt-3 text-sm font-medium text-red-700" role="alert">{error}</p>}
                <button type="submit" class="btn-primary mt-5 w-full" disabled={busy}>{busy ? <Spinner /> : t('Send the code')}</button>
              </form>
            )}

            {(step === 'reset' || step === 'setup') && (
              <ResetForm setup={step === 'setup'} email={email} policy={policy} busy={busy} error={error}
                demoCode={isDemo ? demoCode : undefined} resendIn={resendIn}
                onBack={() => go('password')} onSubmit={(c, pw) => void doReset(c, pw)} onResend={() => void askReset()} />
            )}

            {step === 'done' && (
              <div>
                <h1 class="title flex items-center gap-2 text-xl font-bold"><CheckCircle2 class="size-5 text-brand-700" />{t('Your password is set')}</h1>
                <p class="mt-2 text-sm text-muted">{t('Sign in with {email} and the password you just chose.', { email })}</p>
                <button type="button" class="btn-primary mt-5 w-full" onClick={() => go('password')}>{t('Go to sign in')}</button>
              </div>
            )}
          </div>
        </div>

        {step === 'password' && (isDemo
          ? <DemoAccounts door={door} onPick={(e) => { setEmail(e); setPassword('WetaSnap#2026'); }} />
          : <DevAccountsPanel door={door} demo={demo} onPick={(e) => { setEmail(e); setPassword(demo.password); }} />)}
        <Copyright class="mt-6" />
      </div>
    </div>
  );
}

function DemoNote({ children }: { children: preact.ComponentChildren }) {
  return <p class="mt-3 rounded-xl bg-ocean-50 px-3 py-2 text-sm text-ocean-800">{children}</p>;
}

/** Fallback when the phone is lost: one of the saved recovery codes. */
function RecoveryInput({ onSubmit, disabled }: { onSubmit: (code: string) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  if (!open) return <button type="button" class="mt-4 min-h-11 text-xs font-semibold text-ocean-700 hover:underline" onClick={() => setOpen(true)}>{t('Use a recovery code instead')}</button>;
  return (
    <form class="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); onSubmit(code); }}>
      <input class="input font-mono uppercase" placeholder="ABCD-EFGH" value={code} onInput={(e) => setCode(e.currentTarget.value)} aria-label={t('Recovery code')} />
      <button class="btn-secondary shrink-0 px-3" disabled={disabled || code.replace(/\W/g, '').length < 8}>{t('Use')}</button>
    </form>
  );
}

/**
 * Code + new password + the same password again. `setup` is the first time an invited person
 * uses it (they arrived from the invitation email, with the code in it); otherwise it is a reset.
 */
function ResetForm({ setup, email, policy, busy, error, demoCode, resendIn, onBack, onSubmit, onResend }: {
  setup?: boolean; email: string; policy: SecurityPolicy; busy: boolean; error: string; demoCode?: string; resendIn: number;
  onBack: () => void; onSubmit: (code: string, password: string) => void; onResend: () => void;
}) {
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const problems = pw ? checkPassword(pw, policy) : [];
  const mismatch = confirm && pw !== confirm;

  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(code, pw); }} noValidate>
      {!setup && (
        <button type="button" class="-ml-1 mb-3 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-muted hover:text-ink" onClick={onBack}>
          <ArrowLeft class="size-4" />{t('Back')}
        </button>
      )}
      <h1 class="title text-xl font-bold">{setup ? t('Set up your password') : t('Choose your password')}</h1>
      <p class="mt-1 text-sm text-muted">
        {setup
          ? t('Welcome to WeTa Snap. Enter the 6-digit code from your invitation email for {email}, then pick the password you will sign in with.', { email })
          : t('Enter the code sent to {email} and your new password.', { email })}
      </p>
      {demoCode && <DemoNote>{t('Demo mode — your code is')} <b class="font-mono tracking-widest">{demoCode}</b></DemoNote>}

      <label class="label mt-4" for="rs-code">{setup ? t('Code from your invitation email') : t('Code from the email')}</label>
      <input id="rs-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus class="input text-center font-mono text-lg tracking-[0.4em]"
        value={code} onInput={(e) => setCode(e.currentTarget.value.replace(/\D/g, ''))} />

      <label class="label mt-3" for="rs-pw">{t('New password')}</label>
      <div class="relative">
        <Lock class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
        <input id="rs-pw" type={show ? 'text' : 'password'} autoComplete="new-password" class="input pr-11 pl-9" value={pw} onInput={(e) => setPw(e.currentTarget.value)} />
        <button type="button" class="absolute top-1/2 right-0 flex size-11 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 hover:bg-subtle"
          onClick={() => setShow((v) => !v)} aria-label={show ? t('Hide password') : t('Show password')}>
          {show ? <EyeOff class="size-4" /> : <Eye class="size-4" />}
        </button>
      </div>
      <PasswordMeter strength={passwordStrength(pw)} problems={problems} show={!!pw} />

      <label class="label mt-3" for="rs-pw2">{t('Type it again')}</label>
      <input id="rs-pw2" type={show ? 'text' : 'password'} autoComplete="new-password" class="input" value={confirm} onInput={(e) => setConfirm(e.currentTarget.value)} />
      {mismatch && <p class="mt-1 text-xs font-medium text-red-700">{t('The two passwords are different.')}</p>}

      {error && <p class="mt-3 text-sm font-medium text-red-700" role="alert">{error}</p>}
      <button type="submit" class="btn-primary mt-5 w-full" disabled={busy || code.length !== 6 || problems.length > 0 || !pw || pw !== confirm}>
        {busy ? <Spinner /> : setup ? t('Set up my password') : t('Save the password')}
      </button>
      <button type="button" class="mt-3 min-h-11 w-full text-xs font-semibold text-ocean-700 disabled:text-slate-400" disabled={resendIn > 0} onClick={onResend}>
        {resendIn > 0 ? t('Resend in {s}s', { s: resendIn }) : setup ? t('Email me a new code') : t('Send a new code')}
      </button>
      {setup && (
        <button type="button" class="mt-1 min-h-11 w-full text-xs font-semibold text-muted hover:text-ink" onClick={onBack}>
          {t('I already have a password — sign in')}
        </button>
      )}
    </form>
  );
}

export function PasswordMeter({ strength, problems, show }: { strength: number; problems: string[]; show: boolean }) {
  if (!show) return null;
  const colour = ['bg-red-500', 'bg-red-500', 'bg-amber-400', 'bg-ocean-500', 'bg-brand-500'][strength]!;
  return (
    <div class="mt-2">
      <div class="flex items-center gap-2">
        <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
          <div class={`h-full rounded-full transition-all ${colour}`} style={{ width: `${(strength / 4) * 100}%` }} />
        </div>
        <span class="text-[11px] font-semibold text-muted">{t(STRENGTH_LABEL[strength]!)}</span>
      </div>
      {problems.length > 0 && (
        <ul class="mt-1.5 space-y-0.5">{problems.map((p) => <li key={p} class="text-[11px] text-amber-800">• {t(p)}</li>)}</ul>
      )}
    </div>
  );
}

/** Six boxes; paste supported; auto-submits on the 6th digit. */
function CodeBoxes({ onComplete, disabled }: { onComplete: (code: string) => void; disabled: boolean }) {
  const [digits, setDigits] = useState<string[]>(Array(6).fill(''));
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  useEffect(() => refs.current[0]?.focus(), []);

  function update(next: string[]) {
    setDigits(next);
    if (next.every((d) => d)) onComplete(next.join(''));
  }
  function onInput(i: number, v: string) {
    const clean = v.replace(/\D/g, '');
    if (clean.length > 1) {
      const next = [...digits];
      clean.slice(0, 6 - i).split('').forEach((c, j) => { next[i + j] = c; });
      update(next);
      refs.current[Math.min(5, i + clean.length)]?.focus();
      return;
    }
    const next = [...digits];
    next[i] = clean;
    update(next);
    if (clean && i < 5) refs.current[i + 1]?.focus();
  }

  return (
    <div class="mt-5 grid grid-cols-6 gap-1.5 sm:gap-2" onPaste={(e) => {
      const txt = e.clipboardData?.getData('text') ?? '';
      if (/\d{6}/.test(txt)) { e.preventDefault(); onInput(0, txt.match(/\d{6}/)![0]); }
    }}>
      {digits.map((d, i) => (
        <input key={i} ref={(el) => { refs.current[i] = el; }} value={d} disabled={disabled}
          inputMode="numeric" autoComplete={i === 0 ? 'one-time-code' : 'off'} maxLength={i === 0 ? 6 : 1} aria-label={t('Digit {n}', { n: i + 1 })}
          class="h-12 w-full min-w-0 rounded-xl border border-line bg-surface text-center text-xl font-bold tabular-nums outline-none focus:border-ocean-500 focus:ring-2 focus:ring-ocean-100 sm:h-13"
          onInput={(e) => onInput(i, e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !digits[i] && i > 0) { refs.current[i - 1]?.focus(); const n = [...digits]; n[i - 1] = ''; setDigits(n); }
          }} />
      ))}
    </div>
  );
}

/**
 * The accounts this deployment has, for demonstrating — one tap fills the address and the password.
 * It only draws anything when the API said it is a development one (lib/devAccounts.ts), so a real
 * deployment shows nothing at all.
 */
function DevAccountsPanel({ door, demo, onPick }: { door: Door; demo: DevAccounts; onPick: (email: string) => void }) {
  const wanted = door === 'console' ? ['super_admin'] : ['client_admin', 'staff'];
  const accounts = demo.accounts.filter((a) => wanted.includes(a.role));
  if (!demo.password || !accounts.length) return null;

  return (
    <div class="mt-4 rounded-2xl border border-dashed border-line bg-surface/70 p-4">
      <p class="text-xs font-semibold text-muted">
        {t('Demo accounts — tap to fill (password {password})', { password: demo.password })}
      </p>
      <div class="mt-2 flex flex-wrap gap-2">
        {accounts.map((a) => (
          <button key={a.email} type="button" class="chip border-line bg-surface text-xs hover:border-brand-500"
            onClick={() => onPick(a.email)} title={a.email}>
            <span class="font-semibold text-brand-800">{a.name || a.email}</span>
            <span class="text-muted">{a.role === 'super_admin' ? t('WeTano') : a.role === 'client_admin' ? t('Admin') : t('Scanner')}</span>
          </button>
        ))}
      </div>
      <p class="mt-2 text-[11px] text-muted">
        {door === 'console'
          ? t('The 6-digit code appears here on the next screen.')
          : t('Scanner accounts need no code; an admin\u2019s code appears on the next screen.')}
      </p>
    </div>
  );
}

/** Demo only: the accounts this door accepts, with the shared demo password filled in. */
function DemoAccounts({ door, onPick }: { door: Door; onPick: (email: string) => void }) {
  const accounts: [string, string, string][] = door === 'console'
    ? [['super@wetano.com', 'WeTano Support', 'WeTano']]
    : [
      ['anna@agroexpo.de', 'Anna Weber', 'Scanner'],
      ['ben@agroexpo.de', 'Ben Keller', 'Scanner'],
      ['admin@agroexpo.de', 'Julia Hoffmann', 'Admin'],
      ['admin@nordicseeds.se', 'Erik Lund', 'Admin'],
    ];
  return (
    <div class="mt-4 rounded-2xl border border-dashed border-line bg-surface/70 p-4">
      <p class="text-xs font-semibold text-muted">{t('Demo accounts — tap to fill (password WetaSnap#2026)')}</p>
      <div class="mt-2 flex flex-wrap gap-2">
        {accounts.map(([e, name, role]) => (
          <button key={e} type="button" class="chip border-line bg-surface text-xs hover:border-brand-500" onClick={() => onPick(e)}>
            <span class="font-semibold text-brand-800">{name}</span><span class="text-muted">{t(role)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
