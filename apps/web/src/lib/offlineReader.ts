import type { ReadResult } from './backend';
import { pushOcrText } from './ocrLog';

/**
 * Reading a card on the device itself (AI-05): Tesseract runs in the browser, so a card can be
 * read with no server, no cloud account and no cost. It is the last link in the chain — the
 * company's own OCR service first, then the cloud reader, then this.
 *
 * The language data is fetched once per language and cached by the browser, so only the languages
 * actually needed are downloaded: the company's own, plus English (most cards carry some English).
 *
 * Card tuning (readOffline): the photo is upscaled + normalised first, Tesseract is set to one
 * uniform block at 300 dpi with inter-word spaces preserved, and weak / decoration words are
 * dropped before the text reaches parseCardText.
 */
const TESS_LANG: Record<string, string> = {
  en: 'eng', de: 'deu', fr: 'fra', es: 'spa', it: 'ita', nl: 'nld', pt: 'por',
};

const workers = new Map<string, Promise<import('tesseract.js').Worker>>();

function langsFor(language: string) {
  const own = TESS_LANG[language.slice(0, 2).toLowerCase()] ?? 'eng';
  return own === 'eng' ? 'eng' : `${own}+eng`;
}

async function getWorker(language: string) {
  const langs = langsFor(language);
  let w = workers.get(langs);
  if (!w) {
    w = (async () => {
      const T = await import('tesseract.js');
      const worker = await T.createWorker(langs);
      await worker.setParameters({
        tessedit_pageseg_mode: '6', // PSM.SINGLE_BLOCK: a card is one block of text, not a page
        preserve_interword_spaces: '1', // keeps the gutter between two columns as extra spaces
        user_defined_dpi: '300', // phone photos carry no DPI tag; the 70 dpi default mis-scales small print
      });
      return worker;
    })();
    workers.set(langs, w);
  }
  return w;
}

/** Download the language data ahead of the show (on Wi-Fi), so the first card is quick. */
export async function preloadOfflinePack(language = 'en') {
  await getWorker(language);
  localStorage.setItem('wetasnap-offline-pack', 'ready');
}
export const offlinePackReady = () => localStorage.getItem('wetasnap-offline-pack') === 'ready';

export async function readOffline(photo: Blob, language = 'en', opts?: { silent?: boolean }): Promise<ReadResult> {
  const w = await getWorker(language);
  const { data } = await w.recognize(await preprocessForOcr(photo));
  const raw = (data as { text?: string })?.text ?? '';
  // OCR-LOG: popup shows this raw Tesseract text right after the scan (silent for background re-reads).
  if (!opts?.silent) pushOcrText(raw, 'device Tesseract');
  return parseCardText(rebuildText(data as unknown as TesseractData) || raw);
}

/**
 * Upscale + normalise the photo for Tesseract: small print (emails, addresses) is often under
 * 30 px tall after SCAN-06 compression, and Tesseract reads 300 dpi best. In-memory only.
 */
async function preprocessForOcr(photo: Blob): Promise<Blob> {
  try {
    if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return photo;
    const bmp = await createImageBitmap(photo);
    const scale = Math.min(2.5, Math.max(1, 2200 / bmp.width));
    const W = Math.round(bmp.width * scale);
    const H = Math.round(bmp.height * scale);
    if (!W || !H || W * H > 12_000_000) { bmp.close(); return photo; }
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) { bmp.close(); return photo; }
    ctx.drawImage(bmp, 0, 0, W, H);
    bmp.close();
    // Greyscale + autocontrast: stretch the sampled min/max to 0..255 so an off-white
    // card becomes white and grey small print becomes black.
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    let lo = 255, hi = 0;
    for (let i = 0; i < d.length; i += 64) {
      const g = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
      if (g < lo) lo = g;
      if (g > hi) hi = g;
    }
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      const g = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
      const v = Math.max(0, Math.min(255, ((g - lo) / span) * 255));
      d[i] = v; d[i + 1] = v; d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    const out = await new Promise<Blob | null>((res) => {
      try { c.toBlob((b) => res(b), 'image/jpeg', 0.92); } catch { res(null); }
    });
    return out ?? photo;
  } catch {
    return photo;
  }
}

interface TesseractWord { text: string; confidence: number }
interface TesseractLine { text: string; confidence: number; words?: TesseractWord[] }
interface TesseractData { text?: string; lines?: TesseractLine[] }

/** A word Tesseract itself barely saw — unless it carries @, + or digits (emails, phones). */
const WEAK_WORD = (w: TesseractWord) =>
  (w.confidence ?? 0) < 30 && !/[@+\d]/.test(w.text) && w.text.length <= 2;
/** Logo fragments and rule lines: ©, ——, single stray glyphs. */
const DECORATION = /^[©®™•·|_—–\-=:;]{1,4}$/u;

function cleanToken(t: string) {
  return t.replace(/[©®™]+/g, '').trim();
}

/**
 * Rebuild lines from Tesseract's words, dropping what the engine was unsure of and what is
 * decoration rather than text. Falls back to plain text when no word boxes came back.
 */
function rebuildText(data: TesseractData): string {
  const lines = data?.lines;
  if (!lines?.length) return data?.text ?? '';
  const out: string[] = [];
  for (const line of lines) {
    const words = line.words?.length
      ? line.words.filter((w) => !WEAK_WORD(w)).map((w) => cleanToken(w.text))
      : [cleanToken(line.text)];
    const kept = words.filter((t) => t && !DECORATION.test(t));
    if (!kept.length) continue;
    const joined = kept.join(' ').trim();
    if (!/[A-Za-z0-9@+]/u.test(joined)) continue; // a rule or underline, not a line of text
    out.push(joined);
  }
  return out.join('\n');
}

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
const PHONE_CHARS = /(\+?\d[\d\s()./-]{7,}\d)/;
const WEB = /\b((?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?:\/\S*)?\b/i;
const COMPANY = /\b(GmbH|AG|KG|UG|SAS|SARL|S\.?r\.?l\.?|S\.?p\.?A\.?|SL|S\.?A\.?|B\.?V\.?|N\.?V\.?|Lda|Ltd|Limited|LLC|LLP|Inc|Corp|Pvt|OPC|KG|AB|OY|A\/S|ApS|Co\.?|Group|Holding|Insurance|Assurance|Life|Bank|Finance|Financial|Technolog(?:y|ies)|Solutions?|Services?|Systems?|Software|Consulting|Enterprises?|Industr(?:y|ies)|Logistics|Trading|Capital|Partners|Ventures|Labs?|Saatgut|Agritech)\b/i;
/** A hard legal suffix beats a generic word: "LIFE INSURANCE" (logo) must lose to "… Co. Ltd." (legal name). */
const HARD_SUFFIX = /\b(GmbH|AG|KG|UG|SAS|SARL|S\.?r\.?l\.?|S\.?p\.?A\.?|SL|S\.?A\.?|B\.?V\.?|N\.?V\.?|Lda|Ltd|Limited|LLC|LLP|Inc|Corp|Pvt|OPC|AB|A\/S|ApS|Co\.?)\b/i;
const TITLE = /\b(manager|director|head of|head|chief|ceo|cto|cfo|coo|owner|founder|partner|president|vice[- ]president|vp|sales|marketing|purchas|procurement|export|import|leiter(in)?|gesch[äa]ftsf[üu]hrer(in)?|vertrieb|einkauf|directeur|directrice|responsable|responsabile|gerente|director[ao]|inkoper|engineer|consultant|specialist|executive|representative|agronom)/i;
/** Lines that are labels rather than content. */
const LABEL = /^(tel|telephone|telefon|phone|mobile|mob|handy|cell|fax|e-?mail|mail|web|www|address|adresse)\b[:.\s-]*$/i;
const PHONE_LABEL = /\b(tel|telefon|phone|mobile|mob\.?|handy|cell|m|t)\b[:.\s-]*/i;
const MOBILE_LABEL = /\b(mobile|mob\.?|handy|cell|cel|port|gsm)\b[:.\s-]*/i;
const FAX = /\bfax\b/i;
/** “Am Schwabeplan 8, 39164 Magdeburg, Germany” — the last part is usually the country. */
const COUNTRY = /\b(germany|deutschland|france|italy|italia|spain|espa[ñn]a|netherlands|nederland|portugal|belgium|austria|[öo]sterreich|switzerland|schweiz|sweden|denmark|norway|finland|poland|ireland|united kingdom|uk|england|india|usa|united states)\b/i;
/** Dialling code → country, for cards with no printed country ("Chennai 600002" + a +91 number). */
const CC_COUNTRY: Array<[string, string]> = [
  ['351', 'Portugal'], ['358', 'Finland'], ['353', 'Ireland'], ['91', 'India'], ['49', 'Germany'],
  ['43', 'Austria'], ['41', 'Switzerland'], ['33', 'France'], ['39', 'Italy'], ['34', 'Spain'],
  ['31', 'Netherlands'], ['32', 'Belgium'], ['44', 'United Kingdom'], ['46', 'Sweden'],
  ['45', 'Denmark'], ['47', 'Norway'], ['48', 'Poland'],
];

const clean = (v: string) => v.replace(/\s+/g, ' ').trim().replace(/[,;|]+$/, '');

/** Drops rule lines and OCR debris ("ES ——", "PE ——r—rr—"): real lines are mostly letters/digits. */
function looksLikeText(l: string) {
  if (!/[A-Za-z0-9@+]/u.test(l)) return false;
  const symbols = l.replace(/[\p{L}\p{N}\s]/gu, '').length;
  return symbols / l.length <= 0.35;
}

/**
 * Tesseract reads the + of an international number as 4 ("T: 491 8424015630" for +91 …).
 * Restore it when the rest is a plausible calling code + subscriber number.
 */
function repairPhone(p: string) {
  const s = clean(p);
  if (s.startsWith('4')) {
    const digits = s.replace(/\D/g, '');
    const rest = digits.slice(1);
    const cc = CC_COUNTRY.map(([c]) => c).find((c) => rest.startsWith(c));
    if (cc && rest.length >= cc.length + 6 && rest.length <= cc.length + 12) return `+${rest}`;
  }
  return s;
}

/**
 * Turn the lines Tesseract read into card fields. It is a best guess and every value lands in the
 * form for the person to check — which is why each carries a confidence (SCAN-04).
 */
export function parseCardText(text: string): ReadResult {
  // Two-column cards arrive as merged "email   Company" lines (the gutter survives as extra
  // spaces via preserve_interword_spaces). Split them back into one fact per line first.
  const lines = text
    .split('\n')
    .flatMap((l) => l.split(/\t| {2,}/))
    .map((l) => clean(l))
    .filter((l) => l.length > 1 && !LABEL.test(l) && looksLikeText(l));
  const out: ReadResult = {};
  const mark = (value: string, confidence: number, reason?: string) => ({ value, confidence, reason, by: 'offline' as const });
  const used = new Set<string>();

  // Email — the most reliable thing on a card. Tesseract often leaves spaces around the @.
  const email = text.replace(/\s*@\s*/g, '@').match(EMAIL)?.[0];
  if (email) {
    out.email = mark(email.toLowerCase().replace(/^[.,;:]+|[.,;:]+$/g, ''), 0.9);
    used.add(lines.find((l) => EMAIL.test(l)) ?? lines.find((l) => l.includes('@')) ?? '');
  }

  // Phone: the mobile wins (it is the number sales calls); never a fax number.
  const phoneLines = lines.filter((l) => PHONE_CHARS.test(l) && !EMAIL.test(l) && !FAX.test(l));
  const mobileLine = phoneLines.find((l) => MOBILE_LABEL.test(l) || /(^|\s)M\b[:.\s-]/.test(l));
  const phoneLine = mobileLine ?? phoneLines.find((l) => PHONE_LABEL.test(l) || l.includes('+')) ?? phoneLines[0];
  const rawPhone = phoneLine?.match(PHONE_CHARS)?.[1];
  if (rawPhone) {
    const others = phoneLines.length > 1;
    out.phone = mark(repairPhone(rawPhone), others ? 0.7 : 0.8, others ? 'More than one number on the card — check this is the right one' : undefined);
    used.add(phoneLine!);
  }

  // Website, or the email's domain when the card only prints an address.
  const webLine = lines.find((l) => !EMAIL.test(l) && WEB.test(l) && /(www\.|https?:|\.(com|de|fr|it|es|nl|pt|eu|se|dk|no|fi|at|ch|be|ie|in|co\.uk|net|org))/i.test(l));
  const web = webLine?.match(WEB)?.[1];
  if (web) {
    out.website = mark(web.startsWith('http') ? web : `https://${web}`, 0.8);
    used.add(webLine!);
  } else if (email) {
    out.website = mark(`https://${email.split('@')[1]}`, 0.45, 'Guessed from the email address');
  }

  // Country: printed on the card first, otherwise worked out from the dialling code.
  const countryLine = lines.find((l) => COUNTRY.test(l));
  if (countryLine) {
    const found = countryLine.match(COUNTRY)![0];
    out.country = mark(found.charAt(0).toUpperCase() + found.slice(1), 0.7);
    used.add(countryLine);
  } else if (out.phone) {
    const digits = out.phone.value.replace(/\D/g, '');
    const hit = CC_COUNTRY.find(([cc]) => digits.startsWith(cc));
    if (hit) out.country = mark(hit[1], 0.6, 'Worked out from the dialling code');
  }

  // Company: a legal form wins; otherwise the first line, which is usually the letterhead.
  const candidates = lines.filter((l) => COMPANY.test(l) && !used.has(l) && !EMAIL.test(l));
  const companyLine = candidates.find((l) => HARD_SUFFIX.test(l)) ?? candidates[0];
  let company = companyLine ?? lines.find((l) => !used.has(l) && !/[@\d]/.test(l));
  if (companyLine) {
    // A letterhead often splits the name over two lines: “NORDSAAT” above “Saatgut GmbH”.
    const above = lines[lines.indexOf(companyLine) - 1];
    if (above && !used.has(above) && above.split(/\s+/).length <= 3 && !/[@\d]/.test(above)
      && !TITLE.test(above) && !COMPANY.test(above) && above === above.toUpperCase()) {
      company = `${above} ${companyLine}`;
      used.add(above);
    }
  }
  if (company) {
    out.company = mark(company, companyLine ? 0.8 : 0.5, companyLine ? undefined : 'Taken from the top of the card');
    used.add(company);
    if (companyLine) used.add(companyLine);
  }

  // Job title. Stray glyphs from the card's rules land on this line ("Manager ©/q/Y").
  const titleLine = lines.find((l) => TITLE.test(l) && !used.has(l));
  if (titleLine) {
    let title = clean(titleLine).replace(/\s*[©®™]+$/u, '');
    if (title.split(/\s+/).length >= 3) title = title.replace(/\s[A-Za-z]$/u, '');
    out.job_title = mark(title, 0.7);
    used.add(titleLine);
  }

  // Name: two to four capitalised words (a lone initial counts: "Jayakumar P"), no digits,
  // that is not the company or the title.
  // “Dr. Katharina Vogel” → the honorific is dropped, “Katharina” / “Vogel”.
  const nameLine = lines.find((l) => !used.has(l) && !/[@\d]/.test(l) && !COMPANY.test(l)
    && /^((dr|prof|mr|mrs|ms|ing|dipl)\.?\s+)?([A-ZÀ-Ý][\p{L}'’-]*[\s.]+){1,3}[A-ZÀ-Ý][\p{L}'’-]*$/u.test(l));
  if (nameLine) {
    const parts = nameLine.replace(/^((dr|prof|mr|mrs|ms|ing|dipl)\.?\s+)+/i, '').split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      out.first_name = mark(parts.slice(0, -1).join(' '), 0.75);
      out.last_name = mark(parts.at(-1)!, 0.75);
    }
  } else if (email) {
    // Last resort: many company addresses are first.last@…
    const local = email.split('@')[0]!;
    const m = local.match(/^([a-z]+)[._-]([a-z]+)$/i);
    if (m) {
      const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
      out.first_name = mark(cap(m[1]!), 0.4, 'Guessed from the email address');
      out.last_name = mark(cap(m[2]!), 0.4, 'Guessed from the email address');
    }
  }

  return out;
}
