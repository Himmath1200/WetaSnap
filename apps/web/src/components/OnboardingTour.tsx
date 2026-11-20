import { useState, useEffect } from 'preact/hooks';
import {
  Camera,
  Users,
  MessageSquare,
  Sparkles,
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  Download,
} from 'lucide-preact';
import { Dialog } from './ui';
import { t } from '../lib/i18n';
import type { Role } from '../lib/types';

interface Props {
  role: Role;
  isOpen?: boolean;
  onClose?: () => void;
}

interface Step {
  title: string;
  badge: string;
  icon: typeof Camera;
  color: string;
  bgColor: string;
  description: string;
  features: string[];
}

export function OnboardingTour({ role, isOpen, onClose }: Props) {
  const storageKey = `wetasnap_tour_completed_${role}`;
  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    if (isOpen !== undefined) {
      setOpen(isOpen);
      if (isOpen) setStepIndex(0);
      return;
    }
    const completed = localStorage.getItem(storageKey);
    if (!completed) {
      // Trigger automatically for new visits / first-time users
      const timer = setTimeout(() => setOpen(true), 600);
      return () => clearTimeout(timer);
    }
  }, [isOpen, storageKey]);

  const steps: Step[] = [
    {
      title: t('Welcome to WeTa Snap!'),
      badge: t('Smart Business Card Scanner'),
      icon: Sparkles,
      color: 'text-brand-600',
      bgColor: 'bg-brand-50 border-brand-200',
      description: t('WeTa Snap lets you instantly capture leads from physical cards, badges, and QR codes at events and business meetings with complete offline capability.'),
      features: [
        t('100% Offline-First: Works with zero internet in exhibition halls'),
        t('Automatic On-Device OCR: Reads names, emails, phones, and job titles'),
        t('Instant Lead Management: Never lose a contact or follow-up'),
      ],
    },
    {
      title: t('Step 1: Scan Business Cards'),
      badge: t('High-Speed Capture'),
      icon: Camera,
      color: 'text-ocean-600',
      bgColor: 'bg-ocean-50 border-ocean-200',
      description: t('Point your camera at any business card. Our anti-blur burst capture detects text instantly with zero delay.'),
      features: [
        t('Capture Front & Back: Store both sides of two-sided cards'),
        t('Permanent Photo Storage: The card image is saved with lead details'),
        t('Duplicate Detection: Warns you if you already captured this email or contact'),
      ],
    },
    {
      title: t('Step 2: Instant Lead Follow-Up'),
      badge: t('WhatsApp & Email Dispatch'),
      icon: MessageSquare,
      color: 'text-emerald-600',
      bgColor: 'bg-emerald-50 border-emerald-200',
      description: t('Reach out to your new contact right away before they leave your booth or meeting.'),
      features: [
        t('Send WhatsApp & Email: One-tap dispatch to the contact'),
        t('Direct File Sharing: Attach PDF brochures, product videos, and photos'),
        t('Website Links: Embed your company website and catalog URLs'),
      ],
    },
    {
      title: t('Step 3: Export & Team Collaboration'),
      badge: t('All Devices Synced'),
      icon: role === 'individual' ? Download : Users,
      color: 'text-purple-600',
      bgColor: 'bg-purple-50 border-purple-200',
      description: role === 'individual'
        ? t('Manage your leads, export to Excel/CSV, and save contacts directly into your phone address book.')
        : t('Collaborate with your booth team. Synchronize all scans across colleagues in real time.'),
      features: [
        t('Export Anytime: Download Excel (.xlsx) and CSV reports with photos'),
        t('Address Book Sync: "Save to Phone" imports contacts to iOS & Android'),
        role === 'individual'
          ? t('Solo & Pro plans for independent professionals')
          : t('Real-time Team Outbox: Auto-syncs to cloud when internet reconnects'),
      ],
    },
    {
      title: t('You are All Set!'),
      badge: t('Start Capturing'),
      icon: CheckCircle2,
      color: 'text-emerald-600',
      bgColor: 'bg-emerald-50 border-emerald-200',
      description: t('You are ready to scan your first card! Tap the scan button anytime to get started. Need help? You can re-open this guide from the menu.'),
      features: [
        t('Tap "Scan" to capture your first card'),
        t('Visit "My Leads" to see your captured contacts'),
        t('Customize your message in "Profile → Follow-Up Messaging"'),
      ],
    },
  ];

  const currentStep = steps[stepIndex]!;

  const handleNext = () => {
    if (stepIndex < steps.length - 1) {
      setStepIndex((i) => i + 1);
    } else {
      handleFinish();
    }
  };

  const handlePrev = () => {
    if (stepIndex > 0) setStepIndex((i) => i - 1);
  };

  const handleFinish = () => {
    localStorage.setItem(storageKey, 'true');
    setOpen(false);
    onClose?.();
  };

  if (!open) return null;

  const Icon = currentStep.icon;

  return (
    <Dialog
      open={open}
      onClose={handleFinish}
      title={
        <div class="flex items-center gap-2">
          <span class="text-xs font-bold uppercase tracking-wider text-brand-600 bg-brand-50 border border-brand-200 px-2.5 py-0.5 rounded-full">
            {t('App Guide')} · {stepIndex + 1}/{steps.length}
          </span>
        </div>
      }
      footer={
        <div class="flex items-center justify-between w-full pt-1">
          {stepIndex > 0 ? (
            <button
              type="button"
              class="btn-ghost text-xs font-semibold gap-1.5 px-3 py-1.5"
              onClick={handlePrev}
            >
              <ArrowLeft class="size-3.5" />
              <span>{t('Back')}</span>
            </button>
          ) : (
            <button
              type="button"
              class="text-xs text-muted hover:text-ink px-2 py-1"
              onClick={handleFinish}
            >
              {t('Skip tour')}
            </button>
          )}

          <div class="flex items-center gap-1.5">
            {steps.map((_, idx) => (
              <span
                key={idx}
                class={`size-2 rounded-full transition-all ${
                  idx === stepIndex ? 'w-5 bg-brand-600' : 'bg-slate-300 dark:bg-slate-600'
                }`}
              />
            ))}
          </div>

          <button
            type="button"
            class="btn-primary text-xs font-semibold gap-1.5 px-4 py-2"
            onClick={handleNext}
          >
            <span>{stepIndex === steps.length - 1 ? t('Start Scanning') : t('Next')}</span>
            <ArrowRight class="size-3.5" />
          </button>
        </div>
      }
    >
      <div class="space-y-4 py-1">
        {/* Step Banner */}
        <div class={`rounded-2xl border p-4.5 flex items-start gap-4 ${currentStep.bgColor} transition-colors`}>
          <div class={`size-12 rounded-xl bg-surface border border-line shadow-xs flex items-center justify-center shrink-0 ${currentStep.color}`}>
            <Icon class="size-6" />
          </div>
          <div class="min-w-0 flex-1">
            <span class="text-[10px] font-bold uppercase tracking-wider text-muted block mb-0.5">
              {currentStep.badge}
            </span>
            <h3 class="text-base font-bold text-ink leading-snug">{currentStep.title}</h3>
            <p class="text-xs text-muted mt-1 leading-relaxed">{currentStep.description}</p>
          </div>
        </div>

        {/* Feature Highlights */}
        <div class="rounded-xl border border-line bg-subtle/50 p-3.5 space-y-2">
          <p class="text-[11px] font-bold uppercase tracking-wider text-muted mb-2">
            {t('Key Highlights')}
          </p>
          {currentStep.features.map((feat, i) => (
            <div key={i} class="flex items-start gap-2.5 text-xs text-ink">
              <span class="size-4 rounded-full bg-emerald-500/15 text-emerald-600 flex items-center justify-center shrink-0 mt-0.5">
                <CheckCircle2 class="size-3" />
              </span>
              <span class="leading-relaxed">{feat}</span>
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
