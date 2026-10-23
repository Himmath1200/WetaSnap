import { useEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { ArrowLeft, ArrowRight, CheckCircle2, Eye, EyeOff, KeyRound, Lock, Mail, MailCheck, ShieldCheck } from 'lucide-preact';
import { backend, isDemo } from '../lib/backend';
import { devAccounts, devCode, type DevAccounts } from '../lib/devAccounts';
import { startSession } from '../lib/session';
import { isEmail } from '../lib/validate';
import { toast } from '../lib/store';
import { DEFAULT_POLICY, STRENGTH_LABEL, checkPassword, passwordStrength } from '../lib/password';

import { t, tn } from '../lib/i18n';
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
 *
 * The door's own dark surface (design, Oct 2026): the `.door-*` classes in styles.css keep it
 * one colour in both themes, with mint as the only accent. It is the first screen anyone sees,
 * so it wears the brand colour rather than the theme's.
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
    <button type="button" class="-ml-1 mb-3 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-door-muted hover:text-door-ink" onClick={() => go(to)}>
      <ArrowLeft class="size-4" />{t('Back')}
    </button>
  );

  // How many steps this account needs only becomes clear as it goes: the dots appear with step 2.
  const stepsFor = step === 'totp' ? 3 : step === 'email_code' ? 2 : 1;
  const stepNo = step === 'email_code' ? 2 : step === 'totp' ? 3 : 1;

  return (
    <div class="door-scope flex min-h-dvh flex-col justify-between bg-door px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] text-door-ink sm:justify-center sm:p-6">
      {/* Ambient glow behind the mark, and nothing to read: it is decoration. */}
      <div aria-hidden="true" class="pointer-events-none fixed -top-40 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-emerald-500/10 blur-[120px]" />

      <div class="relative z-10 mx-auto my-auto flex w-full max-w-[420px] flex-col pt-2 pb-6">
        <header class="mb-6 flex items-center justify-center gap-3">
          <SnapMark />
          <div class="wordmark flex items-baseline text-xl">
            <span class="text-door-ink">WeTa</span>
            <span class="ml-1.5 text-mint">Snap</span>
          </div>
        </header>

        {console_ && (
          <span class="mx-auto mb-4 inline-flex items-center gap-1.5 rounded-full border border-door-line bg-door-card px-3 py-1 text-xs font-semibold text-door-ink">
            <ShieldCheck class="size-3.5 text-mint" />{t('WeTano Console')}
          </span>
        )}

        <main class="door-card relative rounded-2xl p-5 sm:p-7">
          {/* The card's top edge catches a little mint, so it reads as lit from above. */}
          <div aria-hidden="true" class="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-emerald-400/40 to-transparent" />

          {stepsFor > 1 && (step === 'password' || step === 'email_code' || step === 'totp') && (
            <ol class="mb-4 flex items-center gap-1.5" aria-label={t('Sign-in steps')}>
              {Array.from({ length: stepsFor }, (_, i) => (
                <li key={i} class={`h-1.5 flex-1 rounded-full ${i < stepNo ? 'bg-mint' : 'bg-door-line'}`} />
              ))}
            </ol>
          )}

          {step === 'password' && (
            <form onSubmit={submitPassword} noValidate>
              <div class="mb-5">
                <h1 class="mb-1.5 text-xl font-bold text-door-ink">{t('Sign in to WeTa Snap')}</h1>
                <p class="text-xs leading-relaxed text-door-muted sm:text-sm">
                  {console_ ? t('Companies, licences and support for every client.') : t('Scanning, leads and everything else — all in one place.')}
                </p>
              </div>
              {ended && (
                <p class="door-error mb-4">
                  {kept > 0
                    ? tn(kept, 'You were signed out after a quiet spell. {n} lead is still safe on this phone and will be sent when you sign in again.', 'You were signed out after a quiet spell. {n} leads are still safe on this phone and will be sent when you sign in again.')
                    : t('You were signed out. Sign in again to continue.')}
                </p>
              )}

              <label class="door-label" for="si-email">{t('Work email')}</label>
              <div class="group relative">
                <Mail class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-door-muted transition-colors group-focus-within:text-mint" />
                <input id="si-email" type="email" inputMode="email" autoComplete="username" autoFocus class="door-input pl-10"
                  placeholder="name@company.com" value={email} onInput={(e) => setEmail(e.currentTarget.value)} />
              </div>

              <label class="door-label mt-4" for="si-pw">{t('Password')}</label>
              <div class="group relative">
                <Lock class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-door-muted transition-colors group-focus-within:text-mint" />
                <input id="si-pw" type={showPw ? 'text' : 'password'} autoComplete="current-password" class="door-input pr-11 pl-10 tracking-wide"
                  placeholder="••••••••••••" value={password} onInput={(e) => setPassword(e.currentTarget.value)} />
                <button type="button" class="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-door-muted hover:text-door-ink"
                  onClick={() => setShowPw((v) => !v)} aria-label={showPw ? t('Hide password') : t('Show password')}>
                  {showPw ? <EyeOff class="size-4" /> : <Eye class="size-4" />}
                </button>
              </div>

              {error && <p class="door-error mt-3" role="alert">{error}</p>}

              <button type="submit" class="door-cta mt-5 w-full" disabled={busy}>
                <span>{t('Continue')}</span>
                {busy ? <Spinner class="size-4" /> : <ArrowRight class="size-4" />}
              </button>
              <div class="pt-1 text-center">
                <button type="button" class="door-link min-h-11 underline decoration-door-line underline-offset-4 hover:decoration-mint" onClick={() => go('forgot')}>
                  {t('Set or reset password')}
                </button>
              </div>
            </form>
          )}

          {step === 'email_code' && (
            <div>
              {back('password')}
              <h1 class="flex items-center gap-2 text-xl font-bold text-door-ink"><MailCheck class="size-5 text-mint" />{t('Check your email')}</h1>
              <p class="mt-1 text-sm text-door-muted">{t('We sent a 6-digit code to {email}. It lasts 10 minutes.', { email })}</p>
              {demoCode && <DemoNote>{t('Demo mode — your code is')} <b class="font-mono tracking-widest">{demoCode}</b></DemoNote>}
              <CodeBoxes key="email" disabled={busy} onComplete={(c) => void submitEmailCode(c)} />
              {error && <p class="door-error mt-3" role="alert">{error}</p>}
              <div class="mt-4 flex items-center justify-between">
                <button class="door-link min-h-11" disabled={resendIn > 0 || busy} onClick={() => void resend()}>
                  {resendIn > 0 ? t('Resend in {s}s', { s: resendIn }) : t('Resend code')}
                </button>
                {busy && <Spinner class="size-5 text-mint" />}
              </div>
            </div>
          )}

          {step === 'totp' && (
            <div>
              {back('password')}
              <h1 class="flex items-center gap-2 text-xl font-bold text-door-ink"><ShieldCheck class="size-5 text-mint" />
                {t('Authenticator code')}
              </h1>
              <p class="mt-1 text-sm text-door-muted">{t('Enter the 6 digits from your authenticator app, or one of your recovery codes.')}</p>
              {isDemo && <DemoNote>{t('Demo mode — any 6 digits work.')}</DemoNote>}
              <CodeBoxes key="totp" disabled={busy} onComplete={(c) => void submitTotp(c)} />
              <RecoveryInput disabled={busy} onSubmit={(c) => void submitTotp(c)} />
              {error && <p class="door-error mt-3" role="alert">{error}</p>}
            </div>
          )}

          {step === 'forgot' && (
            <form onSubmit={askReset} noValidate>
              {!setupEmail && back('password')}
              <h1 class="flex items-center gap-2 text-xl font-bold text-door-ink"><KeyRound class="size-5 text-mint" />
                {setupEmail ? t('Set your password') : t('Set or reset your password')}
              </h1>
              <p class="mt-1 text-sm text-door-muted">{t('We email a 6-digit code to your work address, then you choose a password.')}</p>
              <label class="door-label mt-5" for="fp-email">{t('Work email')}</label>
              <div class="group relative">
                <Mail class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-door-muted transition-colors group-focus-within:text-mint" />
                <input id="fp-email" type="email" inputMode="email" autoFocus class="door-input pl-10" value={email} onInput={(e) => setEmail(e.currentTarget.value)} />
              </div>
              {error && <p class="door-error mt-3" role="alert">{error}</p>}
              <button type="submit" class="door-cta mt-5 w-full" disabled={busy}>{busy ? <Spinner class="size-4" /> : t('Send the code')}</button>
            </form>
          )}

          {(step === 'reset' || step === 'setup') && (
            <ResetForm setup={step === 'setup'} email={email} policy={policy} busy={busy} error={error}
              demoCode={isDemo ? demoCode : undefined} resendIn={resendIn}
              onBack={() => go('password')} onSubmit={(c, pw) => void doReset(c, pw)} onResend={() => void askReset()} />
          )}

          {step === 'done' && (
            <div>
              <h1 class="flex items-center gap-2 text-xl font-bold text-door-ink"><CheckCircle2 class="size-5 text-mint" />{t('Your password is set')}</h1>
              <p class="mt-2 text-sm text-door-muted">{t('Sign in with {email} and the password you just chose.', { email })}</p>
              <button type="button" class="door-cta mt-5 w-full" onClick={() => go('password')}>{t('Go to sign in')}</button>
            </div>
          )}
        </main>

        {step === 'password' && (isDemo
          ? <DemoAccounts door={door} onPick={(e) => { setEmail(e); setPassword('WetaSnap#2026'); }} />
          : <DevAccountsPanel door={door} demo={demo} onPick={(e) => { setEmail(e); setPassword(demo.password); }} />)}
        <Copyright class="mt-6" />
      </div>
    </div>
  );
}

/** The viewfinder mark on the door: four corner brackets around a sensor dot. */
function SnapMark() {
  return (
    <div class="relative size-10 rounded-xl bg-gradient-to-b from-white/10 to-white/0 p-px shadow-lg shadow-black/40">
      <div class="relative flex size-full items-center justify-center overflow-hidden rounded-[11px] bg-door-card">
        <svg class="size-5 text-emerald-400" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 8V5a1 1 0 0 1 1-1h3" stroke-linecap="round" />
          <path d="M16 4h3a1 1 0 0 1 1 1v3" stroke-linecap="round" />
          <path d="M4 16v3a1 1 0 0 0 1 1h3" stroke-linecap="round" />
          <path d="M16 20h3a1 1 0 0 0 1-1v-3" stroke-linecap="round" />
          <circle class="fill-emerald-400/20" cx="12" cy="12" r="3" />
          <path d="M9 12h6" stroke-dasharray="0.5 2" stroke-linecap="round" />
        </svg>
        <div class="pointer-events-none absolute inset-0 bg-emerald-400/10 mix-blend-screen" />
      </div>
    </div>
  );
}

function DemoNote({ children }: { children: preact.ComponentChildren }) {
  return <p class="door-note mt-3">{children}</p>;
}

/** Fallback when the phone is lost: one of the saved recovery codes. */
function RecoveryInput({ onSubmit, disabled }: { onSubmit: (code: string) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  if (!open) return <button type="button" class="door-link mt-4 min-h-11 hover:underline" onClick={() => setOpen(true)}>{t('Use a recovery code instead')}</button>;
  return (
    <form class="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); onSubmit(code); }}>
      <input class="door-input font-mono uppercase" placeholder="ABCD-EFGH" value={code} onInput={(e) => setCode(e.currentTarget.value)} aria-label={t('Recovery code')} />
      <button class="door-cta shrink-0 px-4" disabled={disabled || code.replace(/\W/g, '').length < 8}>{t('Use')}</button>
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
        <button type="button" class="-ml-1 mb-3 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-door-muted hover:text-door-ink" onClick={onBack}>
          <ArrowLeft class="size-4" />{t('Back')}
        </button>
      )}
      <h1 class="text-xl font-bold text-door-ink">{setup ? t('Set up your password') : t('Choose your password')}</h1>
      <p class="mt-1 text-sm text-door-muted">
        {setup
          ? t('Welcome to WeTa Snap. Enter the 6-digit code from your invitation email for {email}, then pick the password you will sign in with.', { email })
          : t('Enter the code sent to {email} and your new password.', { email })}
      </p>
      {demoCode && <DemoNote>{t('Demo mode — your code is')} <b class="font-mono tracking-widest">{demoCode}</b></DemoNote>}

      <label class="door-label mt-4" for="rs-code">{setup ? t('Code from your invitation email') : t('Code from the email')}</label>
      <input id="rs-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus class="door-input text-center font-mono text-lg tracking-[0.4em]"
        value={code} onInput={(e) => setCode(e.currentTarget.value.replace(/\D/g, ''))} />

      <label class="door-label mt-4" for="rs-pw">{t('New password')}</label>
      <div class="group relative">
        <Lock class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-door-muted transition-colors group-focus-within:text-mint" />
        <input id="rs-pw" type={show ? 'text' : 'password'} autoComplete="new-password" class="door-input pr-11 pl-10" value={pw} onInput={(e) => setPw(e.currentTarget.value)} />
        <button type="button" class="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-door-muted hover:text-door-ink"
          onClick={() => setShow((v) => !v)} aria-label={show ? t('Hide password') : t('Show password')}>
          {show ? <EyeOff class="size-4" /> : <Eye class="size-4" />}
        </button>
      </div>
      <PasswordMeter strength={passwordStrength(pw)} problems={problems} show={!!pw} />

      <label class="door-label mt-4" for="rs-pw2">{t('Type it again')}</label>
      <input id="rs-pw2" type={show ? 'text' : 'password'} autoComplete="new-password" class="door-input" value={confirm} onInput={(e) => setConfirm(e.currentTarget.value)} />
      {mismatch && <p class="mt-1 text-xs font-medium text-red-300">{t('The two passwords are different.')}</p>}

      {error && <p class="door-error mt-3" role="alert">{error}</p>}
      <button type="submit" class="door-cta mt-5 w-full" disabled={busy || code.length !== 6 || problems.length > 0 || !pw || pw !== confirm}>
        {busy ? <Spinner class="size-4" /> : setup ? t('Set up my password') : t('Save the password')}
      </button>
      <button type="button" class="door-link mt-1 min-h-11 w-full disabled:text-door-muted" disabled={resendIn > 0} onClick={onResend}>
        {resendIn > 0 ? t('Resend in {s}s', { s: resendIn }) : setup ? t('Email me a new code') : t('Send a new code')}
      </button>
      {setup && (
        <button type="button" class="door-link mt-1 min-h-11 w-full" onClick={onBack}>
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
        <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-door-line">
          <div class={`h-full rounded-full transition-all ${colour}`} style={{ width: `${(strength / 4) * 100}%` }} />
        </div>
        <span class="text-[11px] font-semibold text-door-muted">{t(STRENGTH_LABEL[strength]!)}</span>
      </div>
      {problems.length > 0 && (
        <ul class="mt-1.5 space-y-0.5">{problems.map((p) => <li key={p} class="text-[11px] text-amber-300">• {t(p)}</li>)}</ul>
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
          class="h-12 w-full min-w-0 rounded-xl border border-door-line bg-door-input text-center text-xl font-bold text-door-ink tabular-nums outline-none transition focus:border-mint focus:ring-2 focus:ring-emerald-500/20 sm:h-13"
          onInput={(e) => onInput(i, e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !digits[i] && i > 0) { refs.current[i - 1]?.focus(); const n = [...digits]; n[i - 1] = ''; setDigits(n); }
          }} />
      ))}
    </div>
  );
}

/** The role tag on a demo account chip: mint for the people who scan, blue for the ones who run it. */
function RoleTag({ children, admin }: { children: preact.ComponentChildren; admin?: boolean }) {
  return (
    <span class={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${admin ? 'border-sky-500/20 bg-sky-500/10 text-sky-400' : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400'}`}>
      {children}
    </span>
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
    <section class="mt-4 rounded-2xl border border-door-line bg-door-card/60 p-4">
      <div class="mb-3 flex items-center justify-between px-1">
        <span class="text-xs font-medium text-door-muted">{t('Demo accounts — tap to fill')}</span>
        <span class="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 font-mono text-[11px] text-emerald-400">{demo.password}</span>
      </div>
      <div class="grid grid-cols-2 gap-2">
        {accounts.map((a) => (
          <button key={a.email} type="button" class="door-chip" onClick={() => onPick(a.email)} title={a.email}>
            <span class="truncate text-xs font-medium text-door-ink">{a.name || a.email}</span>
            <RoleTag admin={a.role === 'super_admin' || a.role === 'client_admin'}>
              {a.role === 'super_admin' ? t('WeTano') : a.role === 'client_admin' ? t('Admin') : t('Scanner')}
            </RoleTag>
          </button>
        ))}
      </div>
      <p class="mt-2 px-1 text-[11px] text-door-muted">
        {door === 'console'
          ? t('The 6-digit code appears here on the next screen.')
          : t('Scanner accounts need no code; an admin\u2019s code appears on the next screen.')}
      </p>
    </section>
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
    <section class="mt-4 rounded-2xl border border-door-line bg-door-card/60 p-4">
      <div class="mb-3 flex items-center justify-between px-1">
        <span class="text-xs font-medium text-door-muted">{t('Demo accounts — tap to fill')}</span>
        <span class="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 font-mono text-[11px] text-emerald-400">WetaSnap#2026</span>
      </div>
      <div class="grid grid-cols-2 gap-2">
        {accounts.map(([e, name, role]) => (
          <button key={e} type="button" class="door-chip" onClick={() => onPick(e)} title={e}>
            <span class="truncate text-xs font-medium text-door-ink">{name}</span>
            <RoleTag admin={role === 'Admin'}>{t(role)}</RoleTag>
          </button>
        ))}
      </div>
    </section>
  );
}
