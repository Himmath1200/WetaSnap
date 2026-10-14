/** Interface languages (Phase 1 ships English; the files exist so DE/FR need no code change). */
export const LANGUAGES = [
  { id: 'en', label: 'English' },
  { id: 'de', label: 'Deutsch (Phase 2)' },
  { id: 'fr', label: 'Français (Phase 2)' },
  { id: 'es', label: 'Español (Phase 2)' },
  { id: 'it', label: 'Italiano (Phase 2)' },
  { id: 'nl', label: 'Nederlands (Phase 2)' },
  { id: 'pt', label: 'Português (Phase 2)' },
];

/** The zones our clients actually work in, plus whatever this device is set to. */
const COMMON = [
  'Europe/Berlin', 'Europe/Paris', 'Europe/Madrid', 'Europe/Rome', 'Europe/Amsterdam', 'Europe/Lisbon',
  'Europe/London', 'Europe/Stockholm', 'Europe/Warsaw', 'Europe/Zurich', 'Europe/Vienna', 'Europe/Dublin',
  'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo',
  'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Sao_Paulo',
  'Africa/Johannesburg', 'Australia/Sydney', 'UTC',
];

export const TIME_ZONES = (() => {
  const here = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
  return [...new Set([here, ...COMMON])].filter(Boolean);
})();
