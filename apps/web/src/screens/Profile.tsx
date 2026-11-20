import { useEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import {
  Bell, BellOff, Calendar, Camera, Check, ChevronRight, CloudOff, Globe, Lock, LogOut,
  Mail, MapPin, MessageSquare, Monitor, Moon, Phone, RotateCcw, ShieldCheck, Smartphone, Sparkles, Store, Sun,
  Trash, Trash2, Upload, User,
} from 'lucide-preact';
import { Dialog, Field, Spinner } from '../components/ui';
import { backend } from '../lib/backend';
import { useStore, toast } from '../lib/store';
import { config, endSession, refreshSession, session, setEvent } from '../lib/session';
import { db, unsyncedCount, type LocalLead } from '../lib/db';
import { syncNow } from '../lib/sync';
import { isOnline, net } from '../lib/net';
import { applyTheme, theme, type ThemePref } from '../lib/theme';
import { enablePush, disablePush, pushState, supportsPush } from '../lib/notifications';
import { LANGUAGES } from '../lib/locale';
import { APP_VERSION, BUILD_DATE } from '../lib/version';
import { doorForRole, linkFor, signInPath } from '../lib/portal';
import { getFollowUpConfig, saveFollowUpConfig, formatFollowUpMessage, DEFAULT_FOLLOWUP_MESSAGE, type FollowUpConfig } from '../lib/followup';
import { t } from '../lib/i18n';

function roleLabel(role: string, plan?: string) {
  if (role === 'super_admin') return t('WeTano Super Admin');
  if (role === 'client_admin') return t('Client Admin');
  if (role === 'organizer') return t('Event Organizer');
  if (role === 'individual') return plan === 'pro' ? t('Individual (Pro)') : t('Individual (Free)');
  return t('Staff');
}

function roleBadgeCls(role: string) {
  if (role === 'super_admin') return 'bg-purple-50 text-purple-700 border border-purple-200';
  if (role === 'client_admin') return 'bg-ocean-50 text-ocean-700 border border-ocean-200';
  if (role === 'organizer') return 'bg-purple-50 text-purple-700 border border-purple-200';
  if (role === 'individual') return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30';
  return 'bg-brand-50 text-brand-700 border border-brand-200';
}

function Section({ title, children, className = '' }: { title?: string; children: preact.ComponentChildren; className?: string }) {
  return (
    <section class={`card overflow-hidden ${className}`}>
      {title && (
        <div class="px-5 py-3 border-b border-line">
          <h2 class="text-xs font-bold text-muted uppercase tracking-wider">{title}</h2>
        </div>
      )}
      <div class="p-5">{children}</div>
    </section>
  );
}

function NavRow({ icon: Icon, label, desc, href, danger = false }: {
  icon: typeof User; label: string; desc?: string; href: string; danger?: boolean;
}) {
  return (
    <a
      href={href}
      class={`flex items-center gap-3 px-5 py-3.5 hover:bg-subtle transition-colors border-b border-line last:border-0 ${danger ? 'text-red-700' : 'text-ink'}`}
    >
      <span class={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${danger ? 'bg-red-50' : 'bg-subtle'}`}>
        <Icon class={`size-4 ${danger ? 'text-red-600' : 'text-muted'}`} />
      </span>
      <span class="flex-1 min-w-0">
        <span class="block text-sm font-semibold leading-tight">{label}</span>
        {desc && <span class="block text-xs text-muted mt-0.5">{desc}</span>}
      </span>
      <ChevronRight class="size-4 text-muted shrink-0" />
    </a>
  );
}

export default function Profile() {
  const s = useStore(session)!;
  const cfg = useStore(config);
  const cur = useStore(theme);
  const push = useStore(pushState);
  const netState = useStore(net);
  const { route } = useLocation();
  const [name, setName] = useState(s.person.name);
  const [phone, setPhone] = useState(s.person.phone);
  const [busy, setBusy] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [confirmOut, setConfirmOut] = useState<null | { waiting: number }>(null);
  const [showRecycleBin, setShowRecycleBin] = useState(false);
  const [deletedCards, setDeletedCards] = useState<LocalLead[]>([]);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [activeScans, setActiveScans] = useState(s.person.monthly_scans ?? 0);
  const [fuConfig, setFuConfig] = useState<FollowUpConfig>(() => getFollowUpConfig(s.person.id, s.company, s.person.role === 'staff'));
  const file = useRef<HTMLInputElement>(null);
  const fuTextareaRef = useRef<HTMLTextAreaElement>(null);
  const fuSelectionRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });

  const recordSelection = (el: HTMLTextAreaElement) => {
    fuSelectionRef.current = {
      start: el.selectionStart ?? el.value.length,
      end: el.selectionEnd ?? el.value.length,
    };
  };

  const insertTagAtCursor = (tag: string) => {
    const el = fuTextareaRef.current;
    const currentMsg = fuConfig.message || '';
    let start = fuSelectionRef.current.start;
    let end = fuSelectionRef.current.end;

    if (el && typeof el.selectionStart === 'number') {
      start = el.selectionStart;
      end = el.selectionEnd;
    }

    start = Math.max(0, Math.min(start, currentMsg.length));
    end = Math.max(start, Math.min(end, currentMsg.length));

    const before = currentMsg.slice(0, start);
    const after = currentMsg.slice(end);
    const updated = `${before}${tag}${after}`;

    setFuConfig((prev) => ({ ...prev, message: updated }));

    const nextPos = start + tag.length;
    fuSelectionRef.current = { start: nextPos, end: nextPos };

    setTimeout(() => {
      if (el) {
        el.focus();
        el.setSelectionRange(nextPos, nextPos);
      }
    }, 0);
  };

  useEffect(() => {
    setFuConfig(getFollowUpConfig(s.person.id, s.company, s.person.role === 'staff'));
    if (s.company?.id) {
      void backend().then((b) => b.company()).then((freshCo) => {
        if (freshCo) {
          const cur = session.get();
          if (cur && cur.company) {
            const next = { ...cur, company: { ...cur.company, ...freshCo } };
            session.set(next);
            void db.session.update('current', { company: next.company });
            setFuConfig(getFollowUpConfig(s.person.id, next.company, s.person.role === 'staff'));
          }
        }
      }).catch(() => {});
    }
  }, [s.person.id, s.person.role, s.company?.id, s.company?.follow_up_message, s.company?.follow_up_auto]);

  useEffect(() => {
    if (s.person.role === 'individual') {
      void db.leads.filter((l) => !l.deleted_at && l.captured_by === s.person.id).count().then(setActiveScans);
    }
  }, [s.person.id, s.person.role]);

  const loadRecycleBin = async () => {
    try {
      const b = await backend();
      const serverCards = await b.recycleBinLeads().catch(() => []);
      if (serverCards && serverCards.length > 0) {
        setDeletedCards(serverCards as LocalLead[]);
        return;
      }
      // Fallback to local offline db
      const localCards = await db.leads
        .filter((l) => Boolean(l.deleted_at) && (s.person.role === 'individual' ? l.captured_by === s.person.id : true))
        .toArray();
      setDeletedCards(localCards);
    } catch {
      setDeletedCards([]);
    }
  };

  const restoreCard = async (id: string) => {
    setRestoringId(id);
    try {
      const b = await backend();
      await b.restoreLead(id).catch(() => {});
      await db.leads.update(id, { deleted_at: null, dirty: 0 }).catch(() => 0);
      void syncNow();
      toast(t('Card restored successfully!'), 'success');
      await loadRecycleBin();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setRestoringId(null);
    }
  };

  const registeredEvents = s.person.role === 'client_admin'
    ? cfg.events
    : cfg.events.filter((e) => (s.person.event_ids ?? []).includes(e.id) || e.id === s.event_id || e.id === s.person.default_event_id);

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

  async function askSignOut() { setConfirmOut({ waiting: await unsyncedCount() }); }
  async function doSignOut() {
    await endSession();
    setConfirmOut(null);
    route(signInPath(doorForRole(s.person.role)));
  }

  const themes: { id: ThemePref; label: string; icon: typeof Sun; desc: string }[] = [
    { id: 'light', label: t('Light'), icon: Sun, desc: t('Always light') },
    { id: 'dark', label: t('Dark'), icon: Moon, desc: t('Always dark') },
    { id: 'system', label: t('System'), icon: Monitor, desc: t('Follows device') },
  ];

  return (
    <div class="mx-auto w-full max-w-3xl pb-8">

      {/* ── Hero header ── */}
      <div class="relative mb-6 overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        {/* Gradient banner */}
        <div class="h-28 brand-gradient relative overflow-hidden">
          <div class="absolute inset-0 opacity-20" style={{
            backgroundImage: 'radial-gradient(circle at 30% 50%, rgba(255,255,255,0.4) 0%, transparent 60%), radial-gradient(circle at 80% 20%, rgba(255,255,255,0.3) 0%, transparent 50%)',
          }} />
          <div class="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-surface to-transparent" />
        </div>

        {/* Avatar + info */}
        <div class="px-5 pb-5 -mt-10 relative">
          <div class="flex items-end gap-4">
            <div class="relative shrink-0">
              <div class="w-20 h-20 rounded-2xl ring-4 ring-surface overflow-hidden bg-subtle flex items-center justify-center">
                {s.person.avatar_url
                  ? <img src={s.person.avatar_url} alt="" class="w-full h-full object-cover" />
                  : <span class="brand-gradient w-full h-full flex items-center justify-center text-white text-2xl font-bold">
                      {s.person.name.split(' ').map((w: string) => w[0]).slice(0, 2).join('').toUpperCase()}
                    </span>
                }
              </div>
              <button
                class="absolute -bottom-1 -right-1 w-7 h-7 rounded-lg bg-surface border border-line shadow-sm flex items-center justify-center hover:bg-subtle transition-colors"
                onClick={() => file.current?.click()}
                aria-label={t('Change picture')}
              >
                {avatarBusy ? <Spinner class="size-3.5" /> : <Camera class="size-3.5 text-muted" />}
              </button>
            </div>

            <div class="flex-1 min-w-0 pb-1">
              <div class="flex flex-wrap items-center gap-2 mb-0.5">
                <h1 class="text-lg font-bold text-ink leading-tight truncate">{s.person.name}</h1>
                <span class={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider shrink-0 ${roleBadgeCls(s.person.role)}`}>
                  {roleLabel(s.person.role, s.person.plan)}
                </span>
              </div>
              <p class="text-sm text-muted truncate">{s.person.email}</p>
              {s.company ? <p class="text-xs text-muted mt-0.5">{s.company.name}</p> : s.person.role === 'individual' ? <p class="text-xs text-emerald-600 dark:text-emerald-400 mt-0.5 font-medium">{s.person.plan === 'pro' ? t('WeTa Snap Pro Account') : t('Individual Free Tier')}</p> : null}
            </div>
          </div>

          {/* Avatar action buttons */}
          <div class="mt-4 flex flex-wrap gap-2">
            <button
              class="btn-secondary min-h-9 px-3 text-xs gap-1.5"
              onClick={() => file.current?.click()}
            >
              <Upload class="size-3.5" />{t('Upload photo')}
            </button>
            {s.person.avatar_url && (
              <button
                class="btn-ghost min-h-9 px-3 text-xs text-red-700 gap-1.5"
                onClick={() => void pickAvatar(null)}
              >
                <Trash2 class="size-3.5" />{t('Remove')}
              </button>
            )}
            <span class="self-center text-[11px] text-muted">{t('Square · under 2 MB')}</span>
          </div>
        </div>
        <input ref={file} type="file" accept="image/*" class="hidden" onChange={(e) => { void pickAvatar(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
      </div>

      {/* ── Desktop 2-col / Mobile 1-col ── */}
      <div class="flex flex-col md:flex-row md:gap-6 md:items-start">

        {/* LEFT column */}
        <div class="flex flex-col gap-4 flex-1 min-w-0">

          {/* Individual User Plan & Quota Card */}
          {s.person.role === 'individual' && (
            <Section title={t('Subscription & Scan Quota')}>
              <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 via-subtle to-transparent">
                <div>
                  <div class="flex items-center gap-2">
                    <span class="text-base font-bold text-ink">
                      {s.person.plan === 'pro' ? t('WeTa Snap Pro Plan') : t('Free Plan (5 scans / month)')}
                    </span>
                    {s.person.plan === 'pro' ? (
                      <span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-emerald-500 text-white">
                        {t('Active')}
                      </span>
                    ) : (
                      <span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-subtle border border-line text-muted">
                        {t('Free Tier')}
                      </span>
                    )}
                  </div>
                  <p class="text-xs text-muted mt-1">
                    {s.person.plan === 'pro'
                      ? t('Unlimited business card scans and advanced AI field verification.')
                      : t('You have used {used} of 5 free scans this month.', { used: activeScans })}
                  </p>
                </div>

                <a
                  href={linkFor(s.person.role, '/upgrade')}
                  class="btn-primary text-xs font-bold gap-1.5 px-4 shrink-0"
                >
                  <Sparkles class="size-3.5" />
                  <span>{s.person.plan === 'pro' ? t('Plan details') : t('Upgrade to Pro')}</span>
                </a>
              </div>

              {/* Offline Mode Testing Toggle for Solo / Individual Users */}
              <div class="mt-3 p-4 rounded-xl border border-dashed border-amber-500/40 bg-amber-500/5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <CloudOff class={`size-4 ${netState.simulatedOffline ? 'text-amber-500' : 'text-muted'}`} />
                    <span class="text-sm font-bold text-ink">{t('Offline Mode (Testing)')}</span>
                    {netState.simulatedOffline ? (
                      <span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-amber-500 text-white">
                        {t('Offline Active')}
                      </span>
                    ) : (
                      <span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-emerald-500/15 text-emerald-600 border border-emerald-500/30">
                        {t('Connected')}
                      </span>
                    )}
                  </div>
                  <p class="text-xs text-muted mt-1 leading-relaxed">
                    {netState.simulatedOffline
                      ? t('Offline mode is ON. Captured business cards are stored locally on your device. Uncheck to reconnect and automatically sync your cards.')
                      : t('Enable to test card scanning in offline mode without internet. All scanned cards save locally and auto-sync as soon as you reconnect.')}
                  </p>
                </div>
                <label class="relative inline-flex items-center cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    role="switch"
                    class="sr-only peer"
                    checked={netState.simulatedOffline}
                    onChange={(e) => {
                      const enabled = e.currentTarget.checked;
                      net.set((x) => ({ ...x, simulatedOffline: enabled }));
                      if (!enabled) {
                        toast(t('Reconnected! Auto-syncing cards...'), 'success');
                        void syncNow();
                      } else {
                        toast(t('Offline mode enabled. Scans will be saved locally on this device.'), 'info');
                      }
                    }}
                  />
                  <span class={`relative h-6 w-11 rounded-full transition-colors ${netState.simulatedOffline ? 'bg-amber-500' : 'bg-slate-200 dark:bg-slate-700'}`}>
                    <span class={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${netState.simulatedOffline ? 'left-5.5' : 'left-0.5'}`} />
                  </span>
                </label>
              </div>
            </Section>
          )}

          {/* Instant Follow-Up Messaging Configuration */}
          {s.person.role !== 'super_admin' && (
            <Section title={t('Instant Lead Follow-Up Message')}>
              <div class="card p-4 space-y-4">
                {/* Auto-Send Switch */}
                <div class="flex items-start justify-between gap-3 pb-3 border-b border-line">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="text-sm font-bold text-ink">{t('Auto-send follow-up message after scan')}</span>
                      {fuConfig.autoSend ? (
                        <span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-emerald-500/15 text-emerald-600 border border-emerald-500/30">
                          {t('Auto ON')}
                        </span>
                      ) : (
                        <span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-subtle text-muted border border-line">
                          {t('Manual Choice')}
                        </span>
                      )}
                      {s.person.role === 'staff' && s.company && (
                        <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-brand-50 text-brand-700 border border-brand-200">
                          {t('Set by Admin')}
                        </span>
                      )}
                    </div>
                    <p class="text-xs text-muted mt-1 leading-relaxed">
                      {s.person.role === 'staff' && s.company
                        ? t('Your organization admin ({company}) controls whether messages send automatically or prompt on each scan.', { company: s.company.name })
                        : fuConfig.autoSend
                        ? t('Automatically opens and dispatches your message to the lead via WhatsApp / Email immediately after saving.')
                        : t('After saving each card, you will be prompted with options to push your message to WhatsApp or Email.')}
                    </p>
                  </div>
                  {!(s.person.role === 'staff' && s.company) && (
                    <label class="relative inline-flex items-center cursor-pointer shrink-0 mt-0.5">
                      <input
                        type="checkbox"
                        role="switch"
                        class="sr-only peer"
                        checked={fuConfig.autoSend}
                        onChange={(e) => {
                          const next = { ...fuConfig, autoSend: e.currentTarget.checked };
                          setFuConfig(next);
                          saveFollowUpConfig(s.person.id, next, s.company?.id);
                          toast(next.autoSend ? t('Auto-send enabled') : t('Manual follow-up prompt enabled'), 'info');
                        }}
                      />
                      <span class={`relative h-6 w-11 rounded-full transition-colors ${fuConfig.autoSend ? 'bg-emerald-500' : 'bg-slate-200 dark:bg-slate-700'}`}>
                        <span class={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${fuConfig.autoSend ? 'left-5.5' : 'left-0.5'}`} />
                      </span>
                    </label>
                  )}
                </div>

                {/* Delivery Channels Checkboxes */}
                <div>
                  <label class="label mb-1.5">{t('Preferred delivery channels')}</label>
                  <div class="grid grid-cols-2 gap-3">
                    <label class="flex items-center gap-2.5 p-3 rounded-xl border border-line bg-subtle cursor-pointer hover:bg-subtle/80 transition">
                      <input
                        type="checkbox"
                        class="size-4 accent-emerald-600 rounded"
                        checked={fuConfig.sendWhatsApp}
                        onChange={(e) => {
                          const next = { ...fuConfig, sendWhatsApp: e.currentTarget.checked };
                          setFuConfig(next);
                          saveFollowUpConfig(s.person.id, next);
                        }}
                      />
                      <MessageSquare class="size-4 text-emerald-600 shrink-0" />
                      <span class="text-xs font-bold text-ink">{t('WhatsApp')}</span>
                    </label>

                    <label class="flex items-center gap-2.5 p-3 rounded-xl border border-line bg-subtle cursor-pointer hover:bg-subtle/80 transition">
                      <input
                        type="checkbox"
                        class="size-4 accent-sky-600 rounded"
                        checked={fuConfig.sendEmail}
                        onChange={(e) => {
                          const next = { ...fuConfig, sendEmail: e.currentTarget.checked };
                          setFuConfig(next);
                          saveFollowUpConfig(s.person.id, next);
                        }}
                      />
                      <Mail class="size-4 text-sky-600 shrink-0" />
                      <span class="text-xs font-bold text-ink">{t('Email')}</span>
                    </label>
                  </div>
                </div>

                {/* Message Template: Editable for Admins/Solo, Read-Only for Staff */}
                {s.person.role === 'staff' && s.company ? (
                  <div>
                    <div class="flex items-center justify-between mb-1.5">
                      <div class="flex items-center gap-2">
                        <Lock class="size-3 text-muted" />
                        <label class="label mb-0">{t('Organization message template')}</label>
                      </div>
                      <span class="text-[10px] text-brand-700 font-semibold">{s.company.name}</span>
                    </div>
                    <div class="rounded-xl border border-line bg-subtle/70 p-3 text-xs text-ink leading-relaxed font-mono">
                      {fuConfig.message || DEFAULT_FOLLOWUP_MESSAGE}
                    </div>
                    <p class="text-[11px] text-muted mt-1.5 leading-relaxed">
                      {t('This message template is managed by your organization admin. When you scan a card, your name ({sender}) and company ({company}) are filled in automatically.', {
                        sender: s.person.name,
                        company: s.company.name,
                      })}
                    </p>
                  </div>
                ) : (
                  <div>
                    <div class="flex items-center justify-between mb-1.5">
                      <label class="label mb-0" for="fu-template">{t('Follow-up message text')}</label>
                      <span class="text-[10px] text-muted">{t('Pushed from your own WhatsApp / Email')}</span>
                    </div>
                    <textarea
                      ref={fuTextareaRef}
                      id="fu-template"
                      rows={3}
                      class="input text-xs leading-relaxed"
                      placeholder={t('Type the message you want to send to your leads...')}
                      value={fuConfig.message}
                      onInput={(e) => {
                        setFuConfig({ ...fuConfig, message: e.currentTarget.value });
                        recordSelection(e.currentTarget);
                      }}
                      onSelect={(e) => recordSelection(e.currentTarget)}
                      onKeyUp={(e) => recordSelection(e.currentTarget)}
                      onMouseUp={(e) => recordSelection(e.currentTarget)}
                    />
                    <div class="flex items-center gap-1.5 flex-wrap mt-2">
                      <span class="text-[10px] text-muted">{t('Insert placeholder:')}</span>
                      {['{name}', '{company}', '{event}', '{sender}'].map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => insertTagAtCursor(tag)}
                          class="px-2 py-0.5 rounded bg-subtle border border-line text-[10px] font-mono text-brand-700 hover:bg-brand-50 hover:border-brand-300 transition active:scale-95 cursor-pointer"
                          title={t('Insert {tag} at cursor position', { tag })}
                        >
                          {tag}
                        </button>
                      ))}
                    </div>

                    {/* Company name input: only comes when the user has {company} in the message template */}
                    {/\{company\}/i.test(fuConfig.message) && !s.company && (
                      <div class="mt-3 p-3.5 rounded-xl border border-brand-500/30 bg-brand-50/20 space-y-1.5 transition-all">
                        <label class="label mb-0 text-xs font-bold text-ink" for="fu-custom-company">
                          {t('Enter your company / brand name:')}
                        </label>
                        <input
                          id="fu-custom-company"
                          type="text"
                          class="input text-xs font-semibold"
                          placeholder={t('e.g. Wetano, Apex Solutions, TechFest Innovations...')}
                          value={fuConfig.senderCompanyName ?? ''}
                          onInput={(e) => setFuConfig({ ...fuConfig, senderCompanyName: e.currentTarget.value })}
                          autoFocus
                        />
                        <p class="text-[11px] text-muted">
                          {t('This company name will replace {company} in messages sent to your leads.')}
                        </p>
                      </div>
                    )}

                    {/* Default website & media attachment links */}
                    <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div class="space-y-1">
                        <label class="label mb-0 text-xs font-bold text-ink" for="fu-website-url">
                          {t('Default Website / Company URL:')}
                        </label>
                        <input
                          id="fu-website-url"
                          type="url"
                          class="input text-xs"
                          placeholder="https://yourcompany.com"
                          value={fuConfig.websiteUrl ?? ''}
                          onInput={(e) => setFuConfig({ ...fuConfig, websiteUrl: e.currentTarget.value })}
                        />
                      </div>
                      <div class="space-y-1">
                        <label class="label mb-0 text-xs font-bold text-ink" for="fu-attachment-url">
                          {t('Default Media / Video / Brochure URL:')}
                        </label>
                        <input
                          id="fu-attachment-url"
                          type="url"
                          class="input text-xs"
                          placeholder="https://youtube.com/watch?v=... or brochure link"
                          value={fuConfig.attachmentUrl ?? ''}
                          onInput={(e) => setFuConfig({ ...fuConfig, attachmentUrl: e.currentTarget.value })}
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* Live Preview */}
                <div class="rounded-xl border border-dashed border-line bg-subtle/60 p-3">
                  <div class="flex items-center justify-between mb-1">
                    <p class="text-[10px] font-bold uppercase tracking-wider text-muted">{t('Preview of message sent to lead:')}</p>
                    <span class="text-[10px] text-emerald-600 font-semibold">
                      {t('From: {sender} ({company})', {
                        sender: s.person.name,
                        company: s.company?.name || fuConfig.senderCompanyName || 'WeTa Snap',
                      })}
                    </span>
                  </div>
                  <p class="text-xs text-ink whitespace-pre-wrap font-sans leading-relaxed bg-surface/80 p-2.5 rounded-lg border border-line/60">
                    {formatFollowUpMessage(
                      fuConfig.message,
                      { fields: { full_name: { value: 'Alex Morgan', by: 'person' }, company: { value: 'Global Tech', by: 'person' } } },
                      s.person.name,
                      'Expo 2026',
                      s.company?.name || fuConfig.senderCompanyName || 'WeTa Snap',
                      fuConfig.attachmentUrl,
                      fuConfig.websiteUrl,
                    )}
                  </p>
                </div>

                <div class="flex justify-end pt-1">
                  <button
                    type="button"
                    class="btn-primary text-xs font-semibold px-4"
                    onClick={async () => {
                      saveFollowUpConfig(s.person.id, fuConfig, s.company?.id);
                      if (s.person.role === 'client_admin') {
                        try {
                          const saved = await (await backend()).saveCompany({
                            follow_up_message: fuConfig.message,
                            follow_up_auto: fuConfig.autoSend,
                          });
                          const cur = session.get();
                          if (cur && cur.company) {
                            const next = { ...cur, company: { ...cur.company, ...saved } };
                            session.set(next);
                            void db.session.update('current', { company: next.company });
                          }
                          await refreshSession();
                        } catch {}
                      }
                      toast(s.person.role === 'staff' && s.company ? t('Delivery channels saved!') : t('Follow-up message settings saved!'), 'success');
                    }}
                  >
                    {s.person.role === 'staff' && s.company ? t('Save Channel Preferences') : t('Save Message Settings')}
                  </button>
                </div>
              </div>
            </Section>
          )}

          {/* Registered Events (for all company users who scan) */}
          {s.person.role !== 'super_admin' && s.person.role !== 'individual' && (
            <Section title={t('My registered events')}>
              {registeredEvents.length === 0 ? (
                <div class="py-6 text-center text-muted">
                  <Store class="size-8 mx-auto mb-2 opacity-50" />
                  <p class="text-sm font-semibold text-ink">{t('No registered events yet')}</p>
                  <p class="text-xs text-muted mt-0.5">{t('Your administrator can assign you to events.')}</p>
                </div>
              ) : (
                <div class="space-y-2.5">
                  {registeredEvents.map((e) => {
                    const isCurrent = e.id === s.event_id;
                    return (
                      <div
                        key={e.id}
                        class={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-xl border transition ${
                          isCurrent ? 'border-brand-500 bg-brand-50/50' : 'border-line bg-subtle/50'
                        }`}
                      >
                        <div class="flex items-start gap-3 min-w-0">
                          <span class={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${isCurrent ? 'bg-brand-100 text-brand-700' : 'bg-surface text-muted border border-line'}`}>
                            <Store class="size-4" />
                          </span>
                          <div class="min-w-0 flex-1">
                            <div class="flex items-center gap-2 flex-wrap">
                              <span class="font-bold text-sm text-ink truncate">{e.name}</span>
                              {isCurrent && (
                                <span class="px-2 py-0.5 rounded-full bg-brand-500 text-white text-[10px] font-bold uppercase tracking-wider">
                                  {t('Active')}
                                </span>
                              )}
                              <span class={`pill text-[10px] ${e.status === 'open' ? 'bg-brand-100 text-brand-800' : 'bg-subtle text-muted'}`}>
                                {e.status === 'open' ? t('Open') : t('Closed')}
                              </span>
                            </div>
                            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs text-muted">
                              {e.venue && (
                                <span class="flex items-center gap-1">
                                  <MapPin class="size-3" />{e.venue}
                                </span>
                              )}
                              {e.booth && (
                                <span>· Booth {e.booth}</span>
                              )}
                              <span class="flex items-center gap-1">
                                <Calendar class="size-3" />
                                {new Date(e.starts_on).toLocaleDateString([], { month: 'short', day: 'numeric' })} – {new Date(e.ends_on).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                              </span>
                            </div>
                          </div>
                        </div>

                        {!isCurrent && e.status === 'open' && (
                          <button
                            class="btn-secondary min-h-9 px-3 text-xs self-start sm:self-center shrink-0"
                            onClick={() => {
                              void setEvent(e.id);
                              toast(t('Active event set to {name}', { name: e.name }), 'success');
                            }}
                          >
                            <Check class="size-3.5" />{t('Switch to this')}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </Section>
          )}

          {/* Personal details */}
          <Section title={t('Personal details')}>
            <div class="flex flex-col gap-4">
              <Field label={t('Full name')} for="pf-name">
                <div class="relative">
                  <User class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
                  <input id="pf-name" class="input pl-9" value={name} onInput={(e) => setName(e.currentTarget.value)} />
                </div>
              </Field>
              <Field label={t('Mobile number')} for="pf-phone">
                <div class="relative">
                  <Phone class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
                  <input id="pf-phone" type="tel" inputMode="tel" class="input pl-9" value={phone} placeholder="+49 151 2345678" onInput={(e) => setPhone(e.currentTarget.value)} />
                </div>
              </Field>
              <Field label={t('Email address')} for="pf-email" hint={t('Contact WeTano to change your email.')}>
                <div class="relative">
                  <Mail class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
                  <Lock class="pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-muted opacity-60" />
                  <input id="pf-email" class="input pl-9 pr-9 opacity-70 cursor-not-allowed" value={s.person.email} disabled />
                </div>
              </Field>
              <div class="pt-1">
                <button class="btn-primary w-full sm:w-auto px-8" disabled={busy} onClick={() => void save()}>
                  {busy ? <Spinner class="size-4" /> : t('Save changes')}
                </button>
              </div>
            </div>
          </Section>

          {/* Appearance */}
          <Section title={t('Appearance')}>
            <div class="flex flex-col gap-4">
              <div class="grid grid-cols-3 gap-2.5" role="radiogroup" aria-label={t('Theme')}>
                {themes.map((i) => (
                  <button
                    key={i.id}
                    role="radio"
                    aria-checked={cur === i.id}
                    onClick={() => applyTheme(i.id)}
                    class={`flex flex-col items-center gap-1.5 rounded-xl border py-3 px-2 text-center transition-all ${
                      cur === i.id
                        ? 'border-brand-500 bg-brand-50 shadow-sm'
                        : 'border-line hover:border-brand-200 hover:bg-subtle'
                    }`}
                  >
                    <span class={`w-8 h-8 rounded-lg flex items-center justify-center ${cur === i.id ? 'bg-brand-100' : 'bg-subtle'}`}>
                      <i.icon class={`size-4 ${cur === i.id ? 'text-brand-700' : 'text-muted'}`} />
                    </span>
                    <span class={`text-xs font-semibold ${cur === i.id ? 'text-brand-700' : 'text-ink'}`}>{i.label}</span>
                    <span class="text-[10px] text-muted leading-tight">{i.desc}</span>
                  </button>
                ))}
              </div>

              <Field label={t('Language')} for="pf-lang" hint={t('German and French arrive in Phase 2.')}>
                <div class="relative">
                  <Globe class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
                  <select id="pf-lang" class="input pl-9" disabled>
                    {LANGUAGES.slice(0, 1).map((l) => <option key={l.id}>{l.label}</option>)}
                  </select>
                </div>
              </Field>

              {supportsPush() && (
                <div class="rounded-xl border border-line p-4 flex items-center gap-3">
                  <span class={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${push === 'granted' ? 'bg-brand-50' : 'bg-subtle'}`}>
                    {push === 'granted' ? <Bell class="size-4 text-brand-700" /> : <BellOff class="size-4 text-muted" />}
                  </span>
                  <div class="flex-1 min-w-0">
                    <p class="text-sm font-semibold text-ink">{t('Push notifications')}</p>
                    <p class="text-xs text-muted mt-0.5">{t('Alerts for failed leads and reminders, even when the app is closed.')}</p>
                  </div>
                  <label class="relative flex items-center shrink-0 cursor-pointer">
                    <input
                      type="checkbox"
                      role="switch"
                      class="sr-only peer"
                      checked={push === 'granted'}
                      onChange={(e) => void (e.currentTarget.checked
                        ? enablePush(import.meta.env.VITE_VAPID_PUBLIC_KEY ?? '')
                        : disablePush()
                      ).then(() => toast(e.currentTarget.checked ? t('Alerts are on for this device') : t('Alerts are off for this device'), 'success'))
                        .catch((err: Error) => toast(err.message, 'error'))}
                    />
                    <span class={`relative h-6 w-11 rounded-full transition-colors ${push === 'granted' ? 'bg-brand-600' : 'bg-slate-200'}`}>
                      <span class={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${push === 'granted' ? 'left-5.5' : 'left-0.5'}`} />
                    </span>
                  </label>
                </div>
              )}
            </div>
          </Section>
        </div>

        {/* RIGHT column */}
        <div class="flex flex-col gap-4 md:w-64 shrink-0 mt-4 md:mt-0">

          {/* Quick links card */}
          <div class="card overflow-hidden">
            <div class="px-5 py-3 border-b border-line">
              <h2 class="text-xs font-bold text-muted uppercase tracking-wider">{t('Account')}</h2>
            </div>
            <NavRow
              icon={ShieldCheck}
              label={t('Security')}
              desc={t('Password, 2FA, recovery codes')}
              href={linkFor(s.person.role, '/security')}
            />
            <NavRow
              icon={Smartphone}
              label={t('Active sessions')}
              desc={t('Devices signed in to your account')}
              href={linkFor(s.person.role, '/security?tab=devices')}
            />
            {s.person.role !== 'super_admin' && (
              <button
                type="button"
                onClick={() => {
                  void loadRecycleBin();
                  setShowRecycleBin(true);
                }}
                class="flex w-full items-center justify-between p-3 text-left hover:bg-subtle transition border-t border-line"
              >
                <div class="flex items-center gap-3 min-w-0">
                  <span class="size-8 rounded-lg bg-red-500/10 text-red-600 flex items-center justify-center shrink-0">
                    <Trash class="size-4" />
                  </span>
                  <div class="min-w-0">
                    <p class="text-xs font-bold text-ink">{t('Recycle bin')}</p>
                    <p class="text-[10px] text-muted truncate">{t('View or restore deleted cards (30 days)')}</p>
                  </div>
                </div>
                <ChevronRight class="size-4 text-muted shrink-0" />
              </button>
            )}
          </div>

          {/* About card */}
          <div class="card p-5">
            <h2 class="text-xs font-bold text-muted uppercase tracking-wider mb-4">{t('About')}</h2>
            <dl class="space-y-3">
              <div class="flex items-center justify-between">
                <dt class="text-xs text-muted">{t('App version')}</dt>
                <dd class="text-xs font-semibold text-ink tabular-nums bg-subtle px-2 py-0.5 rounded-md">{APP_VERSION}</dd>
              </div>
              <div class="flex items-center justify-between">
                <dt class="text-xs text-muted">{t('Build date')}</dt>
                <dd class="text-xs font-semibold text-ink tabular-nums">{BUILD_DATE}</dd>
              </div>
              <div class="flex items-start justify-between gap-2">
                <dt class="text-xs text-muted shrink-0">{t('Signed in as')}</dt>
                <dd class="text-xs font-semibold text-ink truncate text-right">{s.person.email}</dd>
              </div>
            </dl>
          </div>

          {/* Sign out */}
          <button
            class="w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl border border-red-200 bg-red-50 text-red-700 font-semibold text-sm hover:bg-red-100 transition-colors"
            onClick={() => void askSignOut()}
          >
            <span class="w-8 h-8 rounded-lg bg-red-100 flex items-center justify-center shrink-0">
              <LogOut class="size-4 text-red-600" />
            </span>
            <span class="flex-1 text-left">{t('Sign out')}</span>
            <ChevronRight class="size-4 text-red-400 shrink-0" />
          </button>
        </div>
      </div>

      {/* ── Recycle Bin Dialog ── */}
      <Dialog
        open={showRecycleBin}
        onClose={() => setShowRecycleBin(false)}
        title={t('Recycle Bin')}
        footer={<>
          <button class="btn-ghost" onClick={() => setShowRecycleBin(false)}>{t('Close')}</button>
        </>}
      >
        <div class="space-y-3">
          <p class="text-xs text-muted">
            🕒 {t('Cards here were deleted from your active lists. They are safely kept for 30 days, after which they are permanently deleted.')}
          </p>

          {deletedCards.length === 0 ? (
            <div class="py-8 text-center text-muted border border-dashed border-line rounded-xl">
              <Trash class="size-8 mx-auto mb-2 opacity-40 text-muted" />
              <p class="text-sm font-semibold text-ink">{t('Recycle bin is empty')}</p>
              <p class="text-xs text-muted mt-0.5">{t('No deleted cards found.')}</p>
            </div>
          ) : (
            <div class="max-h-72 overflow-y-auto space-y-2 pr-1">
              {deletedCards.map((c) => {
                const name = c.fields?.full_name?.value || c.fields?.first_name?.value || t('Unnamed Card');
                const company = c.fields?.company_name?.value || c.fields?.company?.value || '';
                return (
                  <div key={c.id} class="flex items-center justify-between p-3 rounded-xl border border-line bg-subtle/50">
                    <div class="min-w-0 flex-1">
                      <p class="text-xs font-bold text-ink truncate">{name}</p>
                      {company && <p class="text-[11px] text-muted truncate">{company}</p>}
                      <p class="text-[10px] text-muted mt-0.5">
                        {t('Deleted')} {c.deleted_at ? new Date(c.deleted_at).toLocaleDateString() : t('recently')}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={restoringId === c.id}
                      onClick={() => void restoreCard(c.id)}
                      class="btn-secondary h-8 px-2.5 text-xs font-semibold gap-1 ml-2 shrink-0"
                    >
                      {restoringId === c.id ? <Spinner class="size-3" /> : <RotateCcw class="size-3 text-brand-600" />}
                      <span>{t('Restore')}</span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Dialog>

      {/* ── Sign-out dialog ── */}
      <Dialog
        open={!!confirmOut} onClose={() => setConfirmOut(null)} title={t('Sign out?')}
        footer={<>
          <button class="btn-ghost" onClick={() => setConfirmOut(null)}>{t('Cancel')}</button>
          {confirmOut?.waiting
            ? <button class="btn-primary" disabled={!isOnline()} onClick={async () => { await syncNow(); const w = await unsyncedCount(); if (w === 0) await doSignOut(); else setConfirmOut({ waiting: w }); }}>{t('Sync first')}</button>
            : <button class="btn bg-red-600 text-white hover:bg-red-700" onClick={() => void doSignOut()}>{t('Yes, sign out')}</button>}
        </>}
      >
        {confirmOut?.waiting
          ? <p class="text-sm text-muted">{t('{n} leads are still only on this device. Signing out deletes them — sync first so nothing is lost.', { n: confirmOut.waiting })}</p>
          : <p class="text-sm text-muted">{t('You will need to sign in again. Leads already sent stay safe; anything else on this device is removed.')}</p>}
        {!!confirmOut?.waiting && (
          <button class="mt-3 text-xs font-semibold text-red-700 hover:underline" onClick={() => void doSignOut()}>{t('Sign out anyway and delete them')}</button>
        )}
      </Dialog>
    </div>
  );
}
