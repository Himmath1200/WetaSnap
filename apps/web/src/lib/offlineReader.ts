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
 * dropped before the text reaches parseCardText. parseCardText then repairs Tesseract's usual
 * small-print slips (a + read as 4, B for 8, spaces inside an email, M: read as A:) from the
 * dialling-code table and the card's own sibling numbers — digits only, never invented.
 *
 * Three small ideas (typo table, mixed-line split, bigram similarity) are adapted from
 * syneo-tools-gmbh/Javascript-BCR-Library (Apache-2.0).
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
        tessedit_pageseg_mode: T.PSM.SINGLE_BLOCK, // a card is one block of text, not a page
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

/**
 * Public mailbox providers: somebody@gmail.com says nothing about their company, so the
 * website guess (and only the website guess — the name fallback still uses the local part)
 * must ignore these. Global + regional free mail, kept in sync with FREE_MAIL_DOMAINS in
 * services/ocr/extract.py. Pure.
 */
const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  // Global giants.
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'ymail.com', 'rocketmail.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'aim.com',
  'proton.me', 'protonmail.com', 'pm.me',
  'tutanota.com', 'tutanota.de',
  'zoho.com', 'zohomail.com',
  'mail.com', 'email.com', 'inbox.com', 'usa.com', 'post.com',
  'fastmail.com', 'fastmail.fm',
  'hushmail.com',
  // Regional Yahoo / Microsoft variants.
  'yahoo.fr', 'yahoo.de', 'yahoo.es', 'yahoo.it', 'yahoo.co.uk', 'yahoo.ca',
  'yahoo.com.au', 'yahoo.co.in', 'yahoo.in', 'yahoo.com.br', 'yahoo.com.mx',
  'yahoo.co.jp', 'yahoo.se',
  'hotmail.fr', 'hotmail.de', 'hotmail.es', 'hotmail.it', 'hotmail.co.uk',
  'hotmail.ca', 'hotmail.com.au', 'hotmail.com.br',
  'live.fr', 'live.de', 'live.co.uk', 'live.ca', 'live.com.au', 'live.nl',
  'outlook.fr', 'outlook.de', 'outlook.es',
  'aol.fr', 'aol.de', 'aol.co.uk',
  // German free mail.
  'web.de', 'gmx.de', 'gmx.net', 'gmx.com', 'gmx.at', 'gmx.ch',
  't-online.de', 'freenet.de', 'arcor.de', '1und1.de', 'posteo.de', 'mailbox.org',
  // French free mail.
  'orange.fr', 'wanadoo.fr', 'free.fr', 'sfr.fr', 'laposte.net', 'neuf.fr',
  // Italian free mail.
  'libero.it', 'virgilio.it', 'tiscali.it', 'alice.it', 'tim.it', 'email.it',
  // Spanish / Portuguese free mail.
  'terra.es', 'telefonica.net', 'latinmail.com', 'mixmail.com', 'sapo.pt',
  // Dutch / Belgian free mail.
  'planet.nl', 'hetnet.nl', 'home.nl', 'upcmail.nl', 'ziggo.nl', 'kpnmail.nl',
  'skynet.be', 'telenet.be',
  // British / Irish free mail.
  'btinternet.com', 'sky.com', 'virgin.net', 'virginmedia.com', 'ntlworld.com',
  'blueyonder.co.uk', 'talk21.com', 'eircom.net',
  // Nordic free mail.
  'spray.se', 'telia.com', 'luukku.com', 'mail.dk', 'online.no',
  // Polish / Czech free mail.
  'wp.pl', 'o2.pl', 'interia.pl', 'onet.pl', 'op.pl', 'gazeta.pl',
  'seznam.cz', 'email.cz', 'centrum.cz',
  // North American ISP mail.
  'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'bellsouth.net',
  'charter.net', 'cox.net', 'earthlink.net', 'juno.com',
  'rogers.com', 'shaw.ca', 'telus.net', 'bell.net', 'sympatico.ca', 'videotron.ca',
  // Australia / New Zealand ISP mail.
  'bigpond.com', 'bigpond.net.au', 'optusnet.com.au', 'iinet.net.au',
  'xtra.co.nz',
  // Russian / CIS free mail.
  'yandex.ru', 'yandex.com', 'ya.ru', 'mail.ru', 'inbox.ru', 'list.ru', 'bk.ru',
  'rambler.ru',
  // Asian free mail.
  'qq.com', '163.com', '126.com', 'sina.com', 'sohu.com', 'yeah.net', '139.com',
  'foxmail.com', 'naver.com', 'daum.net', 'hanmail.net', 'nate.com',
  'rediffmail.com', 'docomo.ne.jp', 'ezweb.ne.jp', 'nifty.com',
  // Latin American free mail.
  'uol.com.br', 'bol.com.br', 'terra.com.br', 'ig.com.br', 'globo.com',
  // African / Middle Eastern free mail.
  'webmail.co.za', 'mweb.co.za', 'walla.co.il', 'walla.com', 'maktoob.com',
  'mynet.com', 'tut.by',
]);

/** True for gmail.com and friends — never a company website. Pure: unit-tested. */
export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL_DOMAINS.has(domain.trim().toLowerCase().replace(/\.+$/, ''));
}
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
/** "A:" is a misread "M:" — Tesseract drops the middle stroke on small print. */
const MISREAD_MOBILE = /^A\s*[:.]/i;
const MOBILE_INITIAL = /(^|\s)M\b[:.\s-]/;
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
/** Surname particles: "Sanne de Vries" splits as Sanne / de Vries. */
const PARTICLES = new Set([
  'de', 'del', 'della', 'der', 'den', 'di', 'da', 'das', 'dos', 'du', 'van',
  'von', 'ter', 'ten', 'le', 'la', 'el', 'al', 'bin', 'mc', 'mac',
]);

/**
 * Tesseract's single-character slips, repaired before parsing (typo table adapted from
 * syneo-tools-gmbh/Javascript-BCR-Library, Apache-2.0). Every rule needs letter neighbours,
 * so phone digit runs are never touched.
 */
function repairTypos(text: string): string {
  return text
    .replace(/([A-Za-z0-9])\s*[©®]\s*([A-Za-z0-9])/g, '$1@$2') // "info©firma.de"
    .replace(/,com\b/gi, '.com') // ",com" for ".com"
    .replace(/\.oom\b/gi, '.com') // ".oom" for ".com"
    .replace(/\.eh\b/gi, '.ch') // ".eh" for ".ch"
    .replace(/—/g, '-') // never a long dash
    .replace(/([A-Za-z])\|([A-Za-z])/g, '$1l$2') // pipe for l
    .replace(/([A-Za-z])0([A-Za-z])/g, '$1o$2') // 0 for o inside a word
    .replace(/([A-Za-z]{2})1([A-Za-z]{2})/g, '$1i$2'); // 1 for i inside a word
}

/** Lowercase letters and digits only — the shape of a word without its misreads. */
function squashForSim(s: string) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

/**
 * Bigram (Dice) similarity, adapted from sSimilarity in
 * syneo-tools-gmbh/Javascript-BCR-Library (Apache-2.0): "nordsaat" still matches "nordsat",
 * so one OCR slip doesn't lose the company/domain or name/email link.
 */
function bigramSim(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const pairs = (s: string) => {
    const out: string[] = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  };
  const left = pairs(a);
  const right = pairs(b);
  const taken = new Set<number>();
  let hit = 0;
  for (const p of left) {
    const idx = right.findIndex((q, i) => !taken.has(i) && q === p);
    if (idx >= 0) { taken.add(idx); hit++; }
  }
  return (2 * hit) / (left.length + right.length);
}

/**
 * The company behind an email domain ("enrichspaces.co.in" → "enrichspaces").
 * Multi-part country suffixes (co.uk, co.in, com.au, …) are dropped, then the last
 * remaining label wins, so mail.company.com still resolves to the company.
 * Pure: unit-tested.
 */
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'edu', 'gov', 'ac', 'ne', 'or', 'go']);
export function domainBaseOf(domain: string): string {
  const labels = domain.trim().toLowerCase().replace(/\.+$/, '').split('.').filter(Boolean);
  if (labels.length < 2) return '';
  const tld = labels[labels.length - 1]!;
  const rest = labels.length > 2 && SECOND_LEVEL.has(labels[labels.length - 2]!) && tld.length === 2
    ? labels.slice(0, -2)
    : labels.slice(0, -1);
  const base = (rest[rest.length - 1] ?? '').replace(/[^a-z0-9]/g, '');
  return base.length >= 2 ? base : '';
}

/**
 * How much a card line agrees with the email domain (0–1): exact and containment
 * first, then bigram similarity so one OCR slip ("Ennich Spaces") still matches.
 * This is the name↔company cross-check — a line that IS the domain is the company,
 * never the person. Pure: unit-tested.
 */
export function domainScoreOf(line: string, base: string): number {
  if (!base || base.length < 2) return 0;
  const sq = squashForSim(line);
  if (!sq || sq.length < 3) return 0;
  if (sq === base) return 1;
  if (sq.length >= 4 && base.length >= 4 && (sq.includes(base) || base.includes(sq))) return 0.85;
  for (const w of line.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4)) {
    if (w === base || base.includes(w) || w.includes(base)) return 0.8;
  }
  const sim = bigramSim(sq, base);
  return sim >= 0.55 ? sim : 0;
}

/**
 * A name-shaped line that also matches the email local part ("Priya Nair" next to
 * priya.nair@…) belongs to the person — the company fallback must not steal it
 * before pickName runs. Pure: unit-tested.
 */
export function isPersonLine(line: string, emailLocal: string): boolean {
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  if (!words.every((w) => /^[A-Za-z][\p{L}'’.-]*$/u.test(w))) return false;
  const local = squashForSim(emailLocal);
  if (!local) return false;
  return words.some((w) => {
    const sq = squashForSim(w);
    return sq.length >= 3 && local.includes(sq);
  });
}

/**
 * Collapses whitespace, then strips Tesseract's edge debris: leading rule fragments
 * ("~~ M:…", "| Jayakumar P", "1 M:…") and trailing label punctuation. The trailing
 * dot is kept — it belongs to "B.V." and "S.r.l.".
 */
const clean = (v: string) =>
  v.replace(/\s+/g, ' ')
    .trim()
    .replace(/^([|~_—–\-=:;.,#*]+\s*)+/, '')
    .replace(/^\d+\s+(?=[A-Za-z])/, '')
    .replace(/[,;|~_—–\-=:]+$/, '')
    .trim();

/**
 * Rule lines and OCR debris: fewer than 3 letters/digits, or a long rule mixed with E-fragments
 * ("EE ——— EE eeeee———"), where Tesseract reads the red hairline as Es. Real mixed facts such as
 * "M: +91 … Chennal 600002" carry several solid words (a letter-run of 3+), so they survive.
 */
function isDebris(l: string) {
  if (l.replace(/[^A-Za-z0-9]/g, '').length < 3) return true;
  if (/([—–\-_=|:.Ee])\1{3,}/.test(l) || /[—–_=|]{5,}/.test(l)) {
    const solid = l.split(/\s+/).filter((w) => /[A-Za-z0-9]{3,}/.test(w));
    if (solid.length <= 1) return true;
    // "EE … EE eeeee…" — the only solid words are single-letter runs (E/EE), not facts.
    if (solid.every((w) => /^(E+|[Ee]+)$/.test(w.replace(/[^Ee]/g, '')) || w.replace(/[^A-Za-z]/g, '').length < 2)) return true;
  }
  return false;
}

/** Drops lines that are mostly symbols ("=a F -— : AL — p—— -"): real lines are mostly letters/digits. */
function looksLikeText(l: string) {
  if (!/[A-Za-z0-9@+]/u.test(l)) return false;
  const symbols = l.replace(/[\p{L}\p{N}\s]/gu, '').length;
  return symbols / l.length <= 0.35;
}

/** Longest calling code first, so +351 wins over +35-style prefixes. */
function ccOf(digits: string): string | null {
  const ccs = CC_COUNTRY.map(([c]) => c).sort((a, b) => b.length - a.length);
  return ccs.find((cc) => digits.startsWith(cc)) ?? null;
}

/**
 * Tesseract misreads phone digits on small print: the + becomes 4 ("T: 491 …" for +91 …),
 * label punctuation sticks to the line ("T;: +91 …"), 8 loses a loop and becomes B
 * ("+91 B424015630"). Repair separators and unambiguous glyphs only — digits are never invented here.
 */
function repairPhone(p: string) {
  let s = clean(p);
  s = s.replace(/\s*[;:|]+\s*/g, ' '); // label punctuation left on the line: "T;: +91 …"
  s = s.replace(/(\+\d+)\s*[Bb](\d)/, '$1 8$2'); // B for 8, only between digits
  s = s.replace(/\+9\s*[\)\]\}lI](?=\s*\d)/, '+91'); // "+9) 842…" — the second digit of 91 misread as a bracket
  s = s.replace(/[()]/g, ''); // leftover brackets elsewhere
  s = clean(s);
  if (s.startsWith('4') && !s.startsWith('+')) {
    const digits = s.replace(/\D/g, '');
    const rest = digits.slice(1);
    const cc = CC_COUNTRY.map(([c]) => c).find((c) => rest.startsWith(c));
    if (cc && rest.length >= cc.length + 6 && rest.length <= cc.length + 12) return `+${rest}`;
  }
  return s;
}

/**
 * The email address, glued from Tesseract fragments ("ay 2 kumar.p@…" → "ay2kumar.p@…").
 * The longest local part wins, so a fragment never beats the full address; the domain is
 * taken as printed and never repaired.
 */
function extractEmail(text: string): { email: string; repaired: boolean } | null {
  let best: { email: string; repaired: boolean } | null = null;
  const take = (email: string, repaired: boolean) => {
    if (!best || email.split('@')[0]!.length > best.email.split('@')[0]!.length) best = { email, repaired };
  };
  for (const m of text.replace(/\s*@\s*/g, '@').matchAll(new RegExp(EMAIL.source, 'g'))) take(m[0], false);
  for (let i = 0; i < text.length; i++) {
    if (text.charAt(i) !== '@') continue;
    let l = i - 1;
    let buf = '';
    while (l >= 0 && buf.length < 64) {
      const ch = text.charAt(l);
      if (ch === '\n' || ch === '\r' || !/[A-Za-z0-9._%+\s-]/.test(ch)) break;
      buf = ch + buf;
      l--;
    }
    const local = buf.replace(/\s+/g, '');
    const dm = text.slice(i + 1).match(/^[\w-]+(\.[\w-]+)+/);
    if (!dm || !local) continue;
    const cand = `${local}@${dm[0]}`;
    if (EMAIL.test(cand)) take(cand, /\s/.test(buf));
  }
  return best;
}

/** Best line for the person's name: 2 words and a lone initial beat logo fragments and debris. */
function pickName(lines: string[], used: Set<string>, emailLocal: string, domainBase = ''): string | null {
  let best: string | null = null;
  let bestScore = -1;
  lines.forEach((l, idx) => {
    if (used.has(l) || /[@\d]/.test(l) || COMPANY.test(l) || TITLE.test(l)) return;
    // Cross-check: a line that IS the email domain is the company, never the person.
    if (domainBase && domainScoreOf(l, domainBase) >= 0.75) return;
    const stripped = l.replace(/^((dr|prof|mr|mrs|ms|ing|dipl)\.?\s+)+/i, '');
    const words = stripped.split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 4) return;
    if (!words.every((w) => /^[A-Za-z][\p{L}'’.-]*$/u.test(w))) return;
    if (stripped.replace(/[^A-Za-z]/g, '').length < 3) return;
    let s = 0;
    if (/^[A-Z]/.test(words[0]!)) s += 2;
    if (words.length === 2) s += 2;
    else if (words.length === 3) s += 1;
    if (/^[A-Z]\.?$/.test(words[words.length - 1]!)) s += 2; // a lone initial: "Jayakumar P"
    if (emailLocal) {
      const el = squashForSim(emailLocal);
      let m = 0;
      for (const w of words) {
        const sq = squashForSim(w);
        if (sq.length >= 3 && (el.includes(sq) || bigramSim(sq, el) >= 0.7)) m++;
      }
      s += Math.min(m, 2) * 2;
    }
    if (idx <= 2) s += 1; // the name sits near the top, under the logo
    if (s > bestScore) { bestScore = s; best = stripped; }
  });
  return bestScore >= 3 ? best : null;
}

/** "Sanne de Vries" → Sanne / de Vries. All-lowercase words are capitalised, particles are kept. */
function splitName(full: string): [string, string] {
  const cap = (w: string) => {
    const low = w.toLowerCase();
    if (PARTICLES.has(low)) return low === w ? w : low;
    return /^[a-zà-ÿ]+$/u.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w;
  };
  const words = full.split(/\s+/).filter(Boolean).map(cap);
  if (!words.length) return ['', ''];
  if (words.length === 1) return ['', words[0]!];
  let cut = words.length - 1;
  for (let idx = words.length - 2; idx >= 1; idx--) {
    if (PARTICLES.has(words[idx]!.toLowerCase())) cut = idx;
    else break;
  }
  return [words.slice(0, cut).join(' '), words.slice(cut).join(' ')];
}

/**
 * Turn the lines Tesseract read into card fields. It is a best guess and every value lands in the
 * form for the person to check — which is why each carries a confidence (SCAN-04).
 */
export function parseCardText(text: string): ReadResult {
  // Tesseract's single-character slips first (see repairTypos), then split merged facts.
  // Two-column cards arrive as merged "email   Company" lines (the gutter survives as extra
  // spaces via preserve_interword_spaces); one OCR line also merges labelled facts
  // ("Tel: … Mobile: …"), split on the label boundary the same way.
  const fixed = repairTypos(text);
  const lines = fixed
    .split('\n')
    .flatMap((l) => l.split(/\t| {2,}/))
    .flatMap((l) => l.split(/\s+(?=(?:tel|telephone|telefon|phone|mobile|mob\.?|handy|cell|fax|e-?mail|mail|web|www)\b\s*[:.])/i))
    .map((l) => clean(l))
    .filter((l) => l.length > 1 && !LABEL.test(l) && !isDebris(l) && looksLikeText(l));
  const out: ReadResult = {};
  const mark = (value: string, confidence: number, reason?: string) => ({ value, confidence, reason, by: 'offline' as const });
  const used = new Set<string>();

  // Email — the most reliable thing on a card.
  const found = extractEmail(fixed);
  const email = found?.email.toLowerCase().replace(/^[.,;:]+|[.,;:]+$/g, '') ?? null;
  if (email) {
    const repaired = found!.repaired;
    out.email = mark(email, repaired ? 0.6 : 0.9, repaired ? 'Uncertain characters — check the spelling' : undefined);
    used.add(lines.find((l) => l.includes('@')) ?? '');
  }

  // Phone: the mobile wins (it is the number sales calls); never a fax number.
  // "A:" is Tesseract's M with the middle stroke dropped — treat it as the mobile label.
  interface PhoneCand { line: string; value: string; digits: string; mobile: boolean; repairedCC: boolean }
  const cands: PhoneCand[] = [];
  for (const l of lines.filter((x) => PHONE_CHARS.test(x.replace(/(\d)\s*[Bb]\s*(\d)/g, '$1 8 $2')) && !x.includes('@') && !FAX.test(x))) {
    // B-for-8 happens before the match, otherwise the digit run never matches ("+91 B424015630").
    const norm = l.replace(/(\d)\s*[Bb]\s*(\d)/g, '$1 8 $2');
    const m = norm.match(PHONE_CHARS)?.[1];
    if (!m) continue;
    const value = repairPhone(m);
    const digits = value.replace(/\D/g, '');
    if (digits.length < 7) continue; // a mangled fragment, not a number — leave it for the person
    cands.push({ line: l, value, digits, mobile: MOBILE_LABEL.test(l) || MISREAD_MOBILE.test(l) || MOBILE_INITIAL.test(l), repairedCC: false });
  }
  // A digit Tesseract dropped ("; +9) 8424015630" for +91 …): borrow the calling code from a
  // sibling number on the same card rather than storing a number with no country.
  const knownCCs = new Set(cands.map((c) => ccOf(c.digits)).filter((c): c is string => c !== null));
  for (const c of cands) {
    if (ccOf(c.digits) || c.digits.length < 10) continue;
    for (const sib of knownCCs) {
      if (c.digits.startsWith(sib.charAt(0)) && c.digits.slice(1).length >= 8 && c.digits.slice(1).length <= 12) {
        c.value = `+${sib}${c.digits.slice(1)}`;
        c.digits = `${sib}${c.digits.slice(1)}`;
        c.repairedCC = true;
        break;
      }
    }
  }
  let pick = cands.find((c) => c.mobile)
    ?? cands.find((c) => PHONE_LABEL.test(c.line) || c.line.includes('+'))
    ?? cands[0];
  if (pick) {
    const national = (d: string) => { const cc = ccOf(d); return cc ? d.slice(cc.length) : d; };
    // The mobile label won but its number is visibly shorter than the desk number's — Tesseract
    // dropped digits ("+91 63831 8084" for +91 6383338084). Store the intact number instead.
    const longer = cands.filter((c) => c !== pick && national(c.digits).length >= 10)
      .sort((a, b) => national(b.digits).length - national(a.digits).length)[0];
    let reason = cands.length > 1 ? 'More than one number on the card — check this is the right one' : undefined;
    if (pick.mobile && national(pick.digits).length < 10 && longer) {
      pick = longer;
      reason = 'The mobile number looked incomplete — check this one';
    }
    let conf = cands.length > 1 ? 0.7 : 0.8;
    if (pick.repairedCC || !ccOf(pick.digits)) {
      conf = Math.min(conf, 0.65);
      reason ??= 'Repaired a misread digit — check the number';
    }
    if (national(pick.digits).length < 9) {
      conf = Math.min(conf, 0.5);
      reason ??= 'This number looks incomplete.';
    }
    out.phone = mark(pick.value, conf, reason);
    used.add(pick.line);
  }

  // Website, or the email's domain when the card only prints an address.
  const webLine = lines.find((l) => !l.includes('@') && WEB.test(l) && /(www\.|https?:|\.(com|de|fr|it|es|nl|pt|eu|se|dk|no|fi|at|ch|be|ie|in|co\.uk|net|org))/i.test(l));
  const webPrinted = webLine?.match(WEB)?.[1] ?? null;
  if (webPrinted) {
    out.website = mark(webPrinted.startsWith('http') ? webPrinted : `https://${webPrinted}`, 0.8);
    used.add(webLine!);
  } else if (email) {
    // A public mailbox (gmail, yahoo, proton, …) is not a company website — leave it blank.
    const domain = email.split('@')[1] ?? '';
    if (domain && !isFreeMailDomain(domain)) {
      out.website = mark(`https://${domain}`, 0.45, 'Guessed from the email address');
    }
  }

  // Country: printed on the card first, otherwise worked out from the dialling code.
  const countryLine = lines.find((l) => COUNTRY.test(l));
  if (countryLine) {
    const foundCountry = countryLine.match(COUNTRY)![0];
    out.country = mark(foundCountry.charAt(0).toUpperCase() + foundCountry.slice(1), 0.7);
    used.add(countryLine);
  } else if (out.phone) {
    const hit = CC_COUNTRY.find(([cc]) => out.phone!.value.replace(/\D/g, '').startsWith(cc));
    if (hit) out.country = mark(hit[1], 0.6, 'Worked out from the dialling code');
  }

  // Company: a legal form wins (a merged "email   Company" line contributes what follows the
  // email); otherwise the longest company-like line, so a logo fragment ("gcc INSURANCE")
  // never beats the printed name.
  const hard: string[] = [];
  const soft: string[] = [];
  for (const l of lines) {
    if (used.has(l)) continue;
    const at = l.match(EMAIL);
    if (at) {
      const frag = clean(l.slice(l.indexOf(at[0]) + at[0].length));
      if (frag.length > 3 && COMPANY.test(frag)) (HARD_SUFFIX.test(frag) ? hard : soft).push(frag);
      continue;
    }
    if (COMPANY.test(l)) (HARD_SUFFIX.test(l) ? hard : soft).push(l);
  }
  hard.sort((a, b) => b.length - a.length);
  soft.sort((a, b) => b.length - a.length);
  // Name↔company cross-check from the email domain ("enrichspaces.co.in" → "enrichspaces"):
  // a public mailbox says nothing, but a company domain arbitrates. A printed website
  // arbitrates even better — it outranks the email (0.8 beats 0.75). The fallback below
  // prefers a line that agrees with either — and never the person's own name line, which
  // belongs to the name fields (this is the swap the other way round).
  const emailLocal = email?.split('@')[0] ?? '';
  const emailDomain = email?.split('@')[1] ?? '';
  const domainBase = emailDomain && !isFreeMailDomain(emailDomain) ? domainBaseOf(emailDomain) : '';
  const webHost = webPrinted?.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0] ?? '';
  const siteBase = webHost && !isFreeMailDomain(webHost) ? domainBaseOf(webHost) : '';
  let company = hard[0] ?? soft[0] ?? null;
  let companyWhy: 'suffix' | 'site' | 'domain' | 'top' | null = company ? 'suffix' : null;
  if (!company) {
    const cands = lines.filter((l) =>
      !used.has(l) && !/[@\d]/.test(l) && !TITLE.test(l) && !isPersonLine(l, emailLocal));
    const agree = (base: string) => cands
      .map((l) => ({ l, s: domainScoreOf(l, base) }))
      .sort((a, b) => b.s - a.s)
      .find((r) => r.s >= 0.55)?.l ?? null;
    const siteHit = siteBase ? agree(siteBase) : null;
    const mailHit = !siteHit && domainBase ? agree(domainBase) : null;
    company = siteHit ?? mailHit ?? cands[0] ?? null;
    companyWhy = siteHit ? 'site' : mailHit ? 'domain' : company ? 'top' : null;
  }
  if (company && lines.includes(company)) {
    // A letterhead often splits the name over two lines: “NORDSAAT” above “Saatgut GmbH”.
    const above = lines[lines.indexOf(company) - 1];
    if (above && !used.has(above) && above.split(/\s+/).length <= 3 && !/[@\d]/.test(above)
      && !TITLE.test(above) && !COMPANY.test(above) && above === above.toUpperCase()) {
      company = `${above} ${company}`;
      used.add(above);
    }
  }
  if (company) {
    const hardWon = hard.includes(company) || (company.includes(' ') && hard.some((h) => company!.includes(h)));
    const conf = hardWon ? 0.85 : companyWhy === 'site' ? 0.8 : companyWhy === 'domain' ? 0.75 : 0.5;
    const reason = hardWon ? undefined
      : companyWhy === 'site' ? 'Matches the website address'
      : companyWhy === 'domain' ? 'Matches the email address' : 'Taken from the top of the card';
    out.company = mark(company, conf, reason);
    used.add(company);
  }

  // Job title. Stray glyphs from the card's rules land on this line ("Manager ©/C/Ar.").
  const titleLine = lines.find((l) => TITLE.test(l) && !used.has(l));
  if (titleLine) {
    let title = clean(titleLine).replace(/\s*[©®™]+$/u, '').replace(/\s+[•·|_—–\-=:;.]+$/u, '');
    if (title.split(/\s+/).length >= 3) title = title.replace(/\s[A-Za-z]\.?$/u, '').replace(/\s[A-Za-z]{2}\.$/u, '');
    out.job_title = mark(title, 0.7);
    used.add(titleLine);
  }

  // Name: scored, not first-match — "ayakumar P" (lowercased by a misread) still beats debris.
  // “Dr. Katharina Vogel” → the honorific is dropped, “Katharina” / “Vogel”.
  const nameLine = pickName(lines, used, emailLocal, siteBase || domainBase);
  if (nameLine) {
    const [first, last] = splitName(nameLine);
    if (first && last) {
      out.first_name = mark(first, 0.75);
      out.last_name = mark(last, 0.75);
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

  // Swap guard: a fallback company that IS the person's full name ("Priya Nair" next to
  // priya.nair@…) was stolen from the name fields — drop it rather than store it twice.
  // Only the pure fallback is suspect: a legal suffix or a domain match is never a person.
  if (companyWhy === 'top' && out.company && out.first_name?.value && out.last_name?.value) {
    const co = squashForSim(out.company.value);
    const nm = squashForSim(`${out.first_name.value} ${out.last_name.value}`);
    if (co && co === nm) delete out.company;
  }

  return out;
}
