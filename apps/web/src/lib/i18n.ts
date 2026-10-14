// gettext-style translations: the English text is the key, so every string is translation-ready
// and DE/FR (Phase 2) are just files mapping English → translation (§8.2 Languages).
type Dict = Record<string, string>;
const dicts: Record<string, Dict> = { en: {} };
let current: Dict = dicts.en!;

export function t(text: string, params?: Record<string, string | number>) {
  const s = current[text] ?? text;
  return params ? s.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? '')) : s;
}

export async function setLocale(lang: string) {
  if (!dicts[lang]) {
    try {
      dicts[lang] = (await import(`../locales/${lang}.json`)).default as Dict;
    } catch {
      dicts[lang] = {};
    }
  }
  current = dicts[lang]!;
  document.documentElement.lang = lang;
}

/** Plural-aware t(): picks the `one` or `other` English key, so each form is translatable. */
export function tn(n: number, one: string, other: string, params?: Record<string, string | number>) {
  return t(n === 1 ? one : other, { n, ...params });
}
