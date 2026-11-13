import { useEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { ArrowLeft, ArrowRight, CheckCircle2, Eye, EyeOff, KeyRound, Lock, Mail, MailCheck, ShieldCheck, User, AlertCircle, Ticket, Phone, Smartphone } from 'lucide-preact';
import { backend, isDemo } from '../lib/backend';
import { devCode } from '../lib/devAccounts';
import { startSession } from '../lib/session';
import { isEmail } from '../lib/validate';
import { toast } from '../lib/store';
import { DEFAULT_POLICY, STRENGTH_LABEL, checkPassword, passwordStrength } from '../lib/password';

import { t, tn } from '../lib/i18n';
import { type Door } from '../lib/portal';
import { Copyright, Spinner } from '../components/ui';
import { homeFor } from '../routes';
import type { SecurityPolicy } from '../lib/types';

type Step = 'password' | 'email_code' | 'totp' | 'forgot' | 'setup' | 'reset' | 'done' | 'register';

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
const PENDING_SIGNIN_KEY = 'wetasnap_pending_signin';

function getPendingSignIn(door: Door) {
  try {
    const raw = sessionStorage.getItem(PENDING_SIGNIN_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data && data.door === door && Date.now() - (data.at ?? 0) < 15 * 60_000) {
      return data;
    }
  } catch {}
  return null;
}

export default function SignIn({ door }: { door: Door }) {
  const console_ = door === 'console';
  const { route } = useLocation();
  const hash = new URLSearchParams(location.hash.slice(1));
  const setupEmail = hash.get('setup'); // invitation link: the first-time setup, code in hand
  const pendingAuth = getPendingSignIn(door);
  const [step, setStep] = useState<Step>(setupEmail ? 'setup' : (pendingAuth?.step ?? 'password'));
  const [email, setEmail] = useState(setupEmail ?? hash.get('email') ?? (pendingAuth?.email ?? ''));
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resendIn, setResendIn] = useState(pendingAuth?.resendIn ?? 0);
  const [demoCode, setDemoCode] = useState<string | undefined>(pendingAuth?.demoCode);
  const [policy, setPolicy] = useState<SecurityPolicy>(DEFAULT_POLICY);
  const [ended] = useState(() => sessionStorage.getItem('wetasnap-ended') === '1');
  const [kept] = useState(() => Number(sessionStorage.getItem('wetasnap-kept') ?? 0));

  const [regType, setRegType] = useState<'individual' | 'referral'>('individual');
  const [regName, setRegName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPhone, setRegPhone] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regCode, setRegCode] = useState('');
  const [phoneOtpStage, setPhoneOtpStage] = useState(false);
  const [phoneOtpCode, setPhoneOtpCode] = useState('');
  const [expectedPhoneOtp, setExpectedPhoneOtp] = useState('');

  async function submitRegister(e: Event) {
    e.preventDefault();
    if (!regName.trim()) { setError(t('Please enter your full name.')); return; }
    if (!isEmail(regEmail)) { setError(t('Please enter a valid email address.')); return; }
    const digitsOnly = regPhone.replace(/\D/g, '');
    if (digitsOnly.length < 10) {
      setError(t('Mobile number must be at least 10 digits.'));
      return;
    }
    if (regPassword.length < 6) { setError(t('Password must be at least 6 characters.')); return; }
    if (regType === 'referral' && !regCode.trim()) { setError(t('Please enter the event referral code provided by your organizer.')); return; }

    // Normalize phone number: if exactly 10 digits, default to +91 country code for SMS delivery
    const normalizedPhone = regPhone.trim().startsWith('+')
      ? regPhone.trim()
      : digitsOnly.length === 10
      ? `+91${digitsOnly}`
      : `+${digitsOnly}`;

    // If phone OTP hasn't been sent yet, trigger SMS OTP verification via backend
    if (!phoneOtpStage) {
      setBusy(true); setError('');
      try {
        const b = await backend();
        const res = await b.sendPhoneOtp(normalizedPhone);
        setExpectedPhoneOtp(res.demoCode || '');
        setPhoneOtpStage(true);
        toast(t('Verification code sent to {phone}. Please check your phone messages.', { phone: normalizedPhone }), 'success', 5000);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
      return;
    }

    // Verify phone OTP
    if (expectedPhoneOtp && phoneOtpCode.trim() !== expectedPhoneOtp) {
      setError(t('Incorrect mobile verification OTP. Please check the code sent to your phone.'));
      return;
    }

    setBusy(true); setError('');
    try {
      const signed = regType === 'referral'
        ? await (await backend()).registerReferral({
          name: regName.trim(),
          email: regEmail.trim(),
          phone: normalizedPhone,
          password: regPassword,
          referral_code: regCode.trim(),
        })
        : await (await backend()).registerIndividual({
          name: regName.trim(),
          email: regEmail.trim(),
          phone: normalizedPhone,
          password: regPassword,
        });
      await finish(signed);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const p = new URLSearchParams(window.location.search);
      const ref = p.get('ref') || p.get('code');
      if (ref) {
        setRegCode(ref.trim().toUpperCase());
        setRegType('referral');
        setStep('register');
      }
    }
  }, []);

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

  /**
   * While the code step is open on a development deployment, fetch the code that was just sent and
   * show it — so demonstrating the app never means opening a terminal or a second tab.
   */
  useEffect(() => {
    if (step !== 'email_code' || demoCode) return;
    let stop = false;
    const tick = async () => {
      const code = await devCode(email);
      if (!stop && code) setDemoCode(code);
    };
    void tick();
    const h = setInterval(() => { void tick(); }, 1000);
    return () => { stop = true; clearInterval(h); };
  }, [step, email, demoCode]);
  useEffect(() => {
    if (resendIn <= 0) return;
    const h = setTimeout(() => setResendIn((x: number) => x - 1), 1000);
    return () => clearTimeout(h);
  }, [resendIn]);

  const fail = (e: unknown) => {
    if (e instanceof Error && e.message !== 'offline') {
      setError(e.message);
    } else if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setError(t('You are offline. Connect to the internet to sign in.'));
    } else {
      setError(t('Unable to reach server. Please try again in a moment.'));
    }
  };
  const go = (to: Step) => {
    setStep(to);
    setError('');
    if (to === 'password' || to === 'done') {
      try { sessionStorage.removeItem(PENDING_SIGNIN_KEY); } catch {}
    } else {
      try {
        sessionStorage.setItem(PENDING_SIGNIN_KEY, JSON.stringify({
          door, step: to, email, demoCode, resendIn, at: Date.now(),
        }));
      } catch {}
    }
  };

  async function finish(si: import('../lib/backend').SignedIn) {
    try { sessionStorage.removeItem(PENDING_SIGNIN_KEY); } catch {}
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
      if (r.next === 'email_code') {
        setDemoCode(r.demoCode);
        setResendIn(30);
        try {
          sessionStorage.setItem(PENDING_SIGNIN_KEY, JSON.stringify({
            door, step: 'email_code', email, demoCode: r.demoCode, resendIn: 30, at: Date.now(),
          }));
        } catch {}
        go('email_code');
        return;
      }
      try {
        sessionStorage.setItem(PENDING_SIGNIN_KEY, JSON.stringify({
          door, step: 'totp', email, at: Date.now(),
        }));
      } catch {}
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
      try {
        sessionStorage.setItem(PENDING_SIGNIN_KEY, JSON.stringify({
          door, step: step === 'setup' ? 'setup' : 'reset', email, demoCode: r.demoCode, resendIn: 30, at: Date.now(),
        }));
      } catch {}
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
    <div class="door-scope flex min-h-dvh flex-col justify-between px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] sm:justify-center sm:p-6" style={{ background: 'var(--color-door)' }}>
      {/* Ambient glow — subtle in light, vivid in dark */}
      <div aria-hidden="true" class="pointer-events-none fixed -top-40 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-emerald-500/10 blur-[120px]" />

      <div class="relative z-10 mx-auto my-auto flex w-full max-w-[420px] flex-col pt-2 pb-6">
        <header class="mb-6 flex items-center justify-center gap-2">
          <img src="/logo.png" alt="" width="36" height="36" class="size-9" />
          <div class="wordmark text-[22px]" style={{ color: 'var(--color-door-ink)' }}>
            <span style={{ color: 'var(--color-mint)' }}>WeTa</span><span class="ml-1.5">Snap</span>
          </div>
        </header>

        {console_ && (
          <span class="mx-auto mb-4 inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold" style={{ borderColor: 'var(--color-door-line)', background: 'var(--color-door-card)', color: 'var(--color-door-ink)' }}>
            <ShieldCheck class="size-3.5" style={{ color: 'var(--color-mint)' }} />{t('WeTano Console')}
          </span>
        )}

        <main class="door-card relative rounded-2xl p-5 sm:p-7">
          {/* The card's top edge catches a little mint, so it reads as lit from above. */}
          <div aria-hidden="true" class="absolute inset-x-8 top-0 h-px" style={{ background: 'linear-gradient(to right, transparent, color-mix(in srgb, var(--color-mint) 40%, transparent), transparent)' }} />

          {stepsFor > 1 && (step === 'password' || step === 'email_code' || step === 'totp') && (
            <ol class="mb-4 flex items-center gap-1.5" aria-label={t('Sign-in steps')}>
              {Array.from({ length: stepsFor }, (_, i) => (
                <li key={i} class={`h-1.5 flex-1 rounded-full ${i < stepNo ? 'bg-mint' : 'bg-door-line'}`} />
              ))}
            </ol>
          )}

          {!console_ && (step === 'password' || step === 'register') && (
            <div class="mb-5 flex p-1 rounded-xl border border-door-line bg-door-input">
              <button
                type="button"
                class={`flex-1 py-1.5 px-3 rounded-lg text-xs font-bold transition-all ${
                  step === 'password' ? 'bg-door-card text-mint shadow-sm border border-door-line' : 'text-door-muted hover:text-door-ink'
                }`}
                onClick={() => { setStep('password'); setError(''); }}
              >
                {t('Sign in')}
              </button>
              <button
                type="button"
                class={`flex-1 py-1.5 px-3 rounded-lg text-xs font-bold transition-all ${
                  step === 'register' ? 'bg-door-card text-mint shadow-sm border border-door-line' : 'text-door-muted hover:text-door-ink'
                }`}
                onClick={() => { setStep('register'); setError(''); }}
              >
                {t('Register')}
              </button>
            </div>
          )}

          {step === 'register' && (
            <form onSubmit={submitRegister} noValidate>
              <div class="mb-4">
                <h1 class="mb-1.5 text-xl font-bold" style={{ color: 'var(--color-door-ink)' }}>
                  {regType === 'referral' ? t('Join Event via Referral') : t('Create Individual Account')}
                </h1>
                <p class="text-xs leading-relaxed sm:text-sm" style={{ color: 'var(--color-door-muted)' }}>
                  {regType === 'referral'
                    ? t('Register with an event organizer code. Access is granted for the duration of the event.')
                    : t('Direct access to business card scanning. Includes 5 free scans each month.')}
                </p>
              </div>

              {/* Sub-toggle: Solo Account vs Event Referral */}
              <div class="mb-4 flex p-1 rounded-xl border border-door-line bg-door-input text-xs">
                <button
                  type="button"
                  class={`flex-1 py-1 px-2.5 rounded-lg font-semibold transition-all ${
                    regType === 'individual' ? 'bg-door-card text-mint shadow-sm border border-door-line' : 'text-door-muted hover:text-door-ink'
                  }`}
                  onClick={() => { setRegType('individual'); setError(''); }}
                >
                  {t('Solo Account')}
                </button>
                <button
                  type="button"
                  class={`flex-1 py-1 px-2.5 rounded-lg font-semibold transition-all ${
                    regType === 'referral' ? 'bg-door-card text-mint shadow-sm border border-door-line' : 'text-door-muted hover:text-door-ink'
                  }`}
                  onClick={() => { setRegType('referral'); setError(''); }}
                >
                  {t('Event Referral')}
                </button>
              </div>

              {regType === 'referral' && (
                <div class="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-300">
                  <div class="flex items-start gap-2">
                    <AlertCircle class="size-4 shrink-0 text-amber-400 mt-0.5" />
                    <div>
                      <span class="font-bold text-amber-200">{t('Important Event Notice:')}</span>
                      <p class="mt-0.5 text-amber-300/90">
                        {t('All scanned lead records will be permanently removed 24 hours after the event completes. Remember to export all leads before the deadline.')}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {regType === 'referral' && (
                <div class="mb-4">
                  <div class="flex items-center justify-between mb-1">
                    <label class="door-label mb-0" for="reg-code">{t('Event Referral Code / Link')}</label>
                    {regCode && (
                      <span class="pill bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 text-[10px] font-bold">
                        {t('Linked to Event')}
                      </span>
                    )}
                  </div>
                  <div class="group relative">
                    <Ticket class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-door-muted transition-colors group-focus-within:text-mint" />
                    <input id="reg-code" type="text" class="door-input pl-10 uppercase tracking-widest font-mono font-bold"
                      placeholder="ORG-ABC12" value={regCode} onInput={(e) => setRegCode(e.currentTarget.value.toUpperCase())} />
                  </div>
                  <span class="mt-1 block text-[11px] text-door-muted">
                    {regCode ? t('Auto-applied from your organizer link.') : t('Provided in the invite link sent by your event organizer.')}
                  </span>
                </div>
              )}

              <label class="door-label" for="reg-name">{t('Full name')}</label>
              <div class="group relative">
                <User class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-door-muted transition-colors group-focus-within:text-mint" />
                <input id="reg-name" type="text" autoFocus={regType === 'individual'} class="door-input pl-10"
                  placeholder="Alex Morgan" value={regName} onInput={(e) => setRegName(e.currentTarget.value)} />
              </div>

              <label class="door-label mt-4" for="reg-email">{t('Email address')}</label>
              <div class="group relative">
                <Mail class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-door-muted transition-colors group-focus-within:text-mint" />
                <input id="reg-email" type="email" inputMode="email" autoComplete="email" class="door-input pl-10"
                  placeholder="alex@example.com" value={regEmail} onInput={(e) => setRegEmail(e.currentTarget.value)} />
              </div>

              <label class="door-label mt-4" for="reg-phone">{t('Mobile Number')}</label>
              <div class="group relative">
                <Phone class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-door-muted transition-colors group-focus-within:text-mint" />
                <input id="reg-phone" type="tel" inputMode="tel" autoComplete="tel" class="door-input pl-10"
                  placeholder="+1 234 567 8900" value={regPhone} onInput={(e) => { setRegPhone(e.currentTarget.value); setPhoneOtpStage(false); }} />
              </div>

              {phoneOtpStage && (
                <div class="mt-4 p-3.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10">
                  <div class="flex items-center justify-between mb-1.5">
                    <label class="door-label text-emerald-400 font-bold mb-0" for="reg-phone-otp">
                      {t('Enter Mobile Verification Code (OTP)')}
                    </label>
                    <span class="text-[10px] font-mono text-emerald-300 bg-emerald-500/20 px-1.5 py-0.5 rounded">
                      SMS Sent
                    </span>
                  </div>
                  <div class="group relative">
                    <Smartphone class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-emerald-400" />
                    <input
                      id="reg-phone-otp"
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      class="door-input pl-10 font-mono tracking-[0.25em] font-bold text-emerald-300 border-emerald-500/40"
                      placeholder="123456"
                      value={phoneOtpCode}
                      onInput={(e) => setPhoneOtpCode(e.currentTarget.value.replace(/\D/g, ''))}
                      autoFocus
                    />
                  </div>
                  <p class="text-[11px] text-emerald-300/80 mt-1">
                    {t('One mobile number can only be registered to one account.')}
                  </p>
                </div>
              )}

              <label class="door-label mt-4" for="reg-pw">{t('Choose password')}</label>
              <div class="group relative">
                <Lock class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-door-muted transition-colors group-focus-within:text-mint" />
                <input id="reg-pw" type={showPw ? 'text' : 'password'} class="door-input pr-11 pl-10 tracking-wide"
                  placeholder="••••••••••••" value={regPassword} onInput={(e) => setRegPassword(e.currentTarget.value)} />
                <button type="button" class="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-door-muted hover:text-door-ink"
                  onClick={() => setShowPw((v) => !v)} aria-label={showPw ? t('Hide password') : t('Show password')}>
                  {showPw ? <EyeOff class="size-4" /> : <Eye class="size-4" />}
                </button>
              </div>

              {error && <p class="door-error mt-4">{error}</p>}

              <button class="door-cta mt-6 w-full" type="submit" disabled={busy}>
                {busy ? <Spinner class="size-5" /> : !phoneOtpStage ? t('Verify Phone & Continue') : regType === 'referral' ? t('Verify & Join Event') : t('Verify & Create Account')}
              </button>
            </form>
          )}

          {step === 'password' && (
            <form onSubmit={submitPassword} noValidate>
              <div class="mb-5">
                <h1 class="mb-1.5 text-xl font-bold" style={{ color: 'var(--color-door-ink)' }}>{t('Sign in to WeTa Snap')}</h1>
                <p class="text-xs leading-relaxed sm:text-sm" style={{ color: 'var(--color-door-muted)' }}>
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
              {demoCode ? (
                <DemoNote>{t('Testing code:')} <b class="font-mono tracking-widest text-mint">{demoCode}</b></DemoNote>
              ) : (
                <DemoNote>{t('Waiting for code... (check your email or use test code)')} <button type="button" class="underline ml-1 font-mono" onClick={() => void devCode(email).then((c) => c && setDemoCode(c))}>{t('Fetch code')}</button></DemoNote>
              )}
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

        <Copyright class="mt-6" />
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
