import { createStore } from './store';

export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'wetasnap-theme';
export const theme = createStore<ThemePref>(read());

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** Applies the choice to <html> and keeps the browser UI colour in step. */
export function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
  try { localStorage.setItem(KEY, pref); } catch { /* private mode */ }
  theme.set(pref);
  const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0b1220' : '#047857');
}

export function initTheme() {
  applyTheme(read());
  // When following the device, react to it changing while the app is open.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (theme.get() === 'system') applyTheme('system');
  });
}

export const isDarkNow = () =>
  theme.get() === 'dark' || (theme.get() === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
