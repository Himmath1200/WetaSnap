import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import {
  Check, CheckCircle2, CreditCard, Crown, Lock,
  QrCode, ShieldCheck, Sparkles, Zap,
} from 'lucide-preact';
import { useStore, toast } from '../lib/store';
import { refreshSession, session } from '../lib/session';
import { backend } from '../lib/backend';
import { Dialog, Spinner } from '../components/ui';
import { db } from '../lib/db';
import { t } from '../lib/i18n';
import { linkFor } from '../lib/portal';
import type { IndividualPricingConfig } from '../lib/types';

export default function Upgrade() {
  const s = useStore(session)!;
  const { route } = useLocation();
  const [pricing, setPricing] = useState<IndividualPricingConfig | null>(null);
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'annual'>('monthly');
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [successOpen, setSuccessOpen] = useState(false);

  useEffect(() => {
    void backend().then((b) => b.getIndividualPricing()).then(setPricing).catch(() => {});
  }, []);

  // Form states
  const [cardNumber, setCardNumber] = useState('4242 •••• •••• 4242');
  const [cardExpiry, setCardExpiry] = useState('12/28');
  const [cardCvc, setCardCvc] = useState('123');
  const [cardName, setCardName] = useState(s.person.name || 'Alex Morgan');

  const isPro = s.person.plan === 'pro';
  const [activeScans, setActiveScans] = useState(s.person.monthly_scans ?? 0);
  useEffect(() => {
    void db.leads.filter((l) => !l.deleted_at && l.captured_by === s.person.id).count().then(setActiveScans);
  }, [s.person.id]);
  const monthlyScans = activeScans;
  const freeLimit = pricing?.free_scans_limit ?? 5;
  const monthPriceNum = pricing?.pro_price_month ?? 100;
  const yearPriceNum = pricing?.pro_price_year ?? 1150;
  const price = billingCycle === 'monthly' ? `$${monthPriceNum}` : `$${yearPriceNum.toLocaleString()}`;
  const period = billingCycle === 'monthly' ? '/ month' : '/ year';
  const savedAmt = monthPriceNum * 12 - yearPriceNum;
  const savings = billingCycle === 'annual' && savedAmt > 0 ? t('Save ${n}/year', { n: savedAmt }) : null;

  function openCheckout(cycle: 'monthly' | 'annual') {
    setBillingCycle(cycle);
    setCheckoutOpen(true);
  }

  async function handleCheckout() {
    setBusy(true);
    try {
      await (await backend()).upgradeMyPlan('pro', billingCycle, 'card_visa_4242');
      await refreshSession();
      setCheckoutOpen(false);
      setSuccessOpen(true);
      toast(t('Successfully upgraded to WeTa Snap Pro!'), 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const freeFeatures = pricing?.free_features?.length ? pricing.free_features : [
    t('{n} business card scans per month', { n: freeLimit }),
    t('Fast on-device document alignment'),
    t('Standard offline text extraction'),
    t('Single contact export'),
    t('Standard community support'),
  ];

  const proFeatures = pricing?.pro_features?.length ? pricing.pro_features : [
    t('Unlimited card scans every month'),
    t('Google Gemini AI OCR field verification'),
    t('Bulk Excel (.xlsx), CSV and PDF export'),
    t('Multi-device automatic cloud sync'),
    t('Voice memos & business card photo attachments'),
    t('Priority 24/7 customer support'),
    t('No overage fees or hidden charges'),
  ];

  return (
    <div class="mx-auto w-full max-w-6xl pb-16">
      {/* ── Hero Header ── */}
      <div class="text-center py-6 px-4">
        <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 mb-3">
          <Sparkles class="size-3.5" />
          {t('Individual Pro Tier')}
        </span>
        <h1 class="text-3xl sm:text-4xl font-extrabold tracking-tight text-ink">
          {t('Upgrade to WeTa Snap Pro')}
        </h1>
        <p class="text-sm sm:text-base text-muted max-w-xl mx-auto mt-2">
          {t('Unlimited business card scanning, advanced Google Gemini AI verification, and high-speed exports for solo operators.')}
        </p>

        {/* Status for current user */}
        {isPro ? (
          <div class="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 font-bold text-sm">
            <Crown class="size-4" />
            <span>{t('You are on the Pro Plan · Unlimited Scans Active')}</span>
          </div>
        ) : (
          <div class="mt-4 inline-flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-subtle border border-line text-xs font-semibold text-muted">
            <span>{t('Free Plan Usage:')}</span>
            <span class={`font-bold ${monthlyScans >= freeLimit ? 'text-red-600' : 'text-ink'}`}>
              {monthlyScans} / {freeLimit} {t('scans used this month')}
            </span>
          </div>
        )}

        {/* ── Mobile View Toggle (Shown only on small screens) ── */}
        {!isPro && (
          <div class="md:hidden mt-6 flex items-center justify-center">
            <div class="inline-flex items-center p-1 rounded-2xl border border-line bg-subtle">
              <button
                class={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${
                  billingCycle === 'monthly'
                    ? 'bg-surface text-ink shadow-sm border border-line'
                    : 'text-muted hover:text-ink'
                }`}
                onClick={() => setBillingCycle('monthly')}
              >
                {t('Monthly')}
              </button>
              <button
                class={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all ${
                  billingCycle === 'annual'
                    ? 'bg-surface text-emerald-600 dark:text-emerald-400 shadow-sm border border-line'
                    : 'text-muted hover:text-ink'
                }`}
                onClick={() => setBillingCycle('annual')}
              >
                <span>{t('Yearly')}</span>
                {savedAmt > 0 && (
                  <span class="px-1.5 py-0.5 rounded text-[10px] bg-emerald-500 text-white font-extrabold">
                    {t('Save ${n}', { n: savedAmt })}
                  </span>
                )}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── DESKTOP VIEW: 3 CARDS SIDE BY SIDE (Free, Monthly, Yearly) ── */}
      <div class="hidden md:grid md:grid-cols-3 gap-6 mt-4 items-stretch">
        {/* Desktop Card 1: Free Tier */}
        <div class="card p-6 flex flex-col justify-between border-line">
          <div>
            <div class="flex items-center justify-between mb-1">
              <h3 class="text-lg font-bold text-ink">{t('Free Plan')}</h3>
              {!isPro && (
                <span class="px-2.5 py-0.5 rounded-full text-xs font-bold bg-subtle border border-line text-muted">
                  {t('Current Plan')}
                </span>
              )}
            </div>
            <p class="text-xs text-muted mb-4">{t('For occasional networking and testing')}</p>

            <div class="mb-5">
              <span class="text-3xl font-extrabold text-ink">$0</span>
              <span class="text-xs text-muted ml-1">/ {t('forever')}</span>
            </div>

            <ul class="space-y-3 border-t border-line pt-4 text-xs">
              {freeFeatures.map((f) => (
                <li key={f} class="flex items-start gap-2 text-muted">
                  <Check class="size-4 text-muted shrink-0 mt-0.5" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </div>

          <div class="mt-8 pt-4 border-t border-line">
            <button
              disabled
              class="btn-secondary w-full justify-center text-xs font-semibold opacity-75 cursor-default"
            >
              {!isPro ? t('Current Active Plan') : t('Free Tier')}
            </button>
          </div>
        </div>

        {/* Desktop Card 2: Pro Monthly */}
        <div class="card p-6 flex flex-col justify-between border-line hover:border-emerald-500/40 transition-colors">
          <div>
            <div class="flex items-center justify-between mb-1">
              <h3 class="text-lg font-bold text-ink">{t('Pro Monthly')}</h3>
              <span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-subtle border border-line text-muted">
                {t('Flexible')}
              </span>
            </div>
            <p class="text-xs text-muted mb-4">{t('Month-to-month commitment, cancel anytime')}</p>

            <div class="mb-5 flex items-baseline gap-1.5">
              <span class="text-3xl font-extrabold text-ink">${monthPriceNum}</span>
              <span class="text-xs text-muted">/ {t('month')}</span>
            </div>

            <ul class="space-y-3 border-t border-line pt-4 text-xs font-medium">
              {proFeatures.map((f) => (
                <li key={f} class="flex items-start gap-2 text-ink">
                  <CheckCircle2 class="size-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </div>

          <div class="mt-8 pt-4 border-t border-line">
            {isPro ? (
              <button
                class="btn-secondary w-full justify-center text-xs font-bold gap-1.5"
                onClick={() => toast(t('Your Pro subscription is active.'), 'info')}
              >
                <Crown class="size-3.5 text-emerald-600" />
                <span>{t('Active Plan')}</span>
              </button>
            ) : (
              <button
                class="btn-secondary w-full justify-center text-xs font-bold gap-1.5 py-3 border-emerald-500/40 hover:bg-emerald-500/10 hover:text-emerald-700"
                onClick={() => openCheckout('monthly')}
              >
                <Zap class="size-3.5 text-emerald-600" />
                <span>{t('Upgrade Monthly (${n}/mo)', { n: monthPriceNum })}</span>
              </button>
            )}
          </div>
        </div>

        {/* Desktop Card 3: Pro Yearly (Featured / Best Value) */}
        <div class="card p-6 flex flex-col justify-between border-2 border-emerald-500/50 bg-gradient-to-br from-emerald-500/10 via-surface to-surface shadow-xl relative overflow-hidden">
          <div class="absolute -right-12 -top-12 size-36 bg-emerald-500/15 rounded-full blur-2xl pointer-events-none" />

          <div>
            <div class="flex items-center justify-between mb-1">
              <div class="flex items-center gap-1.5">
                <h3 class="text-lg font-bold text-ink">{t('Pro Yearly')}</h3>
                <span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-emerald-500 text-white">
                  {t('Best Value')}
                </span>
              </div>
            </div>
            <p class="text-xs text-muted mb-4">{t('Billed annually with built-in discount')}</p>

            <div class="mb-5 flex items-baseline gap-1.5 flex-wrap">
              <span class="text-3xl font-extrabold text-ink">${yearPriceNum.toLocaleString()}</span>
              <span class="text-xs text-muted">/ {t('year')}</span>
              {savedAmt > 0 && (
                <span class="ml-1 text-[11px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                  {t('Save ${n}', { n: savedAmt })}
                </span>
              )}
            </div>

            <ul class="space-y-3 border-t border-line pt-4 text-xs font-medium">
              {proFeatures.map((f) => (
                <li key={f} class="flex items-start gap-2 text-ink">
                  <CheckCircle2 class="size-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </div>

          <div class="mt-8 pt-4 border-t border-line">
            {isPro ? (
              <button
                class="btn-secondary w-full justify-center text-xs font-bold gap-1.5"
                onClick={() => toast(t('Your Pro subscription is active.'), 'info')}
              >
                <Crown class="size-3.5 text-emerald-600" />
                <span>{t('Active Plan')}</span>
              </button>
            ) : (
              <button
                class="btn-primary w-full justify-center text-xs font-bold gap-1.5 py-3 shadow-md shadow-emerald-900/20"
                onClick={() => openCheckout('annual')}
              >
                <Sparkles class="size-3.5 text-white" />
                <span>{t('Upgrade Yearly (${n}/yr)', { n: yearPriceNum.toLocaleString() })}</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── MOBILE VIEW: TOGGLE + 2 CARDS (Free + Selected Pro Plan) ── */}
      <div class="md:hidden grid grid-cols-1 gap-6 mt-2">
        {/* Free Plan Card */}
        <div class="card p-6 flex flex-col justify-between border-line">
          <div>
            <div class="flex items-center justify-between">
              <div>
                <h3 class="text-lg font-bold text-ink">{t('Free Plan')}</h3>
                <p class="text-xs text-muted mt-0.5">{t('For occasional networking and testing')}</p>
              </div>
              {!isPro && (
                <span class="px-2.5 py-1 rounded-full text-xs font-bold bg-subtle border border-line text-muted">
                  {t('Current Plan')}
                </span>
              )}
            </div>

            <div class="mt-4 mb-6">
              <span class="text-3xl font-extrabold text-ink">$0</span>
              <span class="text-xs text-muted ml-1">/ {t('forever')}</span>
            </div>

            <ul class="space-y-3 border-t border-line pt-4 text-xs">
              {freeFeatures.map((f) => (
                <li key={f} class="flex items-start gap-2.5 text-muted">
                  <Check class="size-4 text-muted shrink-0 mt-0.5" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </div>

          <div class="mt-6 pt-4 border-t border-line">
            <span class="text-xs text-muted block text-center">
              {t('Standard {n} scan quota resets each calendar month', { n: freeLimit })}
            </span>
          </div>
        </div>

        {/* Pro Plan Card with Mobile Toggle Reaction */}
        <div class="card p-6 flex flex-col justify-between border-2 border-emerald-500/50 bg-gradient-to-br from-emerald-500/10 via-surface to-surface shadow-xl relative overflow-hidden">
          <div class="absolute -right-12 -top-12 size-36 bg-emerald-500/15 rounded-full blur-2xl pointer-events-none" />

          <div>
            <div class="flex items-center justify-between">
              <div>
                <div class="flex items-center gap-2">
                  <h3 class="text-lg font-bold text-ink">{t('WeTa Snap Pro')}</h3>
                  <span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-emerald-500 text-white">
                    {billingCycle === 'annual' ? t('Best Value') : t('Recommended')}
                  </span>
                </div>
                <p class="text-xs text-muted mt-0.5">{t('For active event attendees & deal makers')}</p>
              </div>
              {isPro && (
                <span class="px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-500 text-white flex items-center gap-1">
                  <CheckCircle2 class="size-3.5" />
                  {t('Active')}
                </span>
              )}
            </div>

            <div class="mt-4 mb-6 flex items-baseline gap-1.5 flex-wrap">
              <span class="text-4xl font-extrabold text-ink">{price}</span>
              <span class="text-xs text-muted">{period}</span>
              {savings && (
                <span class="ml-2 text-xs font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                  {savings}
                </span>
              )}
            </div>

            <ul class="space-y-3 border-t border-line pt-4 text-xs font-medium">
              {proFeatures.map((f) => (
                <li key={f} class="flex items-start gap-2.5 text-ink">
                  <CheckCircle2 class="size-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </div>

          <div class="mt-8 pt-4 border-t border-line">
            {isPro ? (
              <button
                class="btn-secondary w-full justify-center text-sm font-bold gap-2"
                onClick={() => toast(t('Your Pro subscription is active and in good standing.'), 'info')}
              >
                <Crown class="size-4 text-emerald-600" />
                <span>{t('Manage Subscription')}</span>
              </button>
            ) : (
              <button
                class="btn-primary w-full justify-center text-sm font-bold gap-2 py-3.5 shadow-md shadow-emerald-900/20"
                onClick={() => openCheckout(billingCycle)}
              >
                <Zap class="size-4" />
                <span>{t('Upgrade to Pro Now — {price}', { price })}</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Interactive Checkout Modal ── */}
      <Dialog
        open={checkoutOpen}
        onClose={() => setCheckoutOpen(false)}
        title={t('Complete Pro Subscription')}
        footer={<>
          <button class="btn-ghost" onClick={() => setCheckoutOpen(false)}>
            {t('Cancel')}
          </button>
          <button
            class="btn-primary min-w-44 font-bold"
            disabled={busy}
            onClick={() => void handleCheckout()}
          >
            {busy ? <Spinner class="size-4 text-white" /> : `${t('Pay')} ${price}`}
          </button>
        </>}
      >
        <div class="space-y-4">
          {/* Order Summary */}
          <div class="p-3.5 rounded-xl border border-line bg-subtle flex items-center justify-between">
            <div>
              <span class="block text-sm font-bold text-ink">WeTa Snap Pro ({billingCycle === 'annual' ? t('Annual') : t('Monthly')})</span>
              <span class="block text-xs text-muted">{t('Unlimited card scans & AI verification')}</span>
            </div>
            <div class="text-right">
              <span class="block text-lg font-extrabold text-emerald-600 dark:text-emerald-400">{price}</span>
              <span class="block text-[10px] text-muted">{period}</span>
            </div>
          </div>

          {/* Interactive Card Inputs */}
          <div class="space-y-3">
            <div>
              <label class="block text-xs font-semibold text-muted mb-1">{t('Cardholder Name')}</label>
              <input
                class="input text-sm"
                value={cardName}
                onInput={(e) => setCardName(e.currentTarget.value)}
                placeholder="Name on card"
              />
            </div>

            <div>
              <label class="block text-xs font-semibold text-muted mb-1">{t('Card Number')}</label>
              <div class="relative">
                <CreditCard class="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted pointer-events-none" />
                <input
                  class="input pl-9 text-sm font-mono"
                  value={cardNumber}
                  onInput={(e) => setCardNumber(e.currentTarget.value)}
                  placeholder="4242 •••• •••• 4242"
                />
              </div>
            </div>

            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-xs font-semibold text-muted mb-1">{t('Expiry Date')}</label>
                <input
                  class="input text-sm font-mono"
                  value={cardExpiry}
                  onInput={(e) => setCardExpiry(e.currentTarget.value)}
                  placeholder="MM/YY"
                />
              </div>
              <div>
                <label class="block text-xs font-semibold text-muted mb-1">{t('Security Code (CVC)')}</label>
                <div class="relative">
                  <Lock class="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted pointer-events-none" />
                  <input
                    class="input pl-8 text-sm font-mono"
                    value={cardCvc}
                    onInput={(e) => setCardCvc(e.currentTarget.value)}
                    placeholder="123"
                  />
                </div>
              </div>
            </div>
          </div>

          <div class="flex items-center gap-2 text-[11px] text-muted justify-center pt-1">
            <ShieldCheck class="size-3.5 text-emerald-600" />
            <span>{t('Encrypted with 256-bit SSL · Instant activation')}</span>
          </div>
        </div>
      </Dialog>

      {/* ── Success Celebration Modal ── */}
      <Dialog
        open={successOpen}
        onClose={() => setSuccessOpen(false)}
        title={t('Welcome to WeTa Snap Pro!')}
        footer={<>
          <button
            class="btn-primary w-full justify-center gap-2 font-bold"
            onClick={() => {
              setSuccessOpen(false);
              route(linkFor(s.person.role, '/scan-v2'));
            }}
          >
            <QrCode class="size-4" />
            <span>{t('Start Scanning Unlimited Leads')}</span>
          </button>
        </>}
      >
        <div class="text-center py-4 space-y-3">
          <div class="size-16 rounded-3xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 mx-auto flex items-center justify-center border border-emerald-500/30">
            <Crown class="size-8" />
          </div>
          <h3 class="text-xl font-bold text-ink">{t('Pro Plan Activated')}</h3>
          <p class="text-sm text-muted max-w-sm mx-auto">
            {t('You now have unlimited business card scans, AI-assisted text extraction, and export capability enabled on all your devices.')}
          </p>
        </div>
      </Dialog>
    </div>
  );
}
