import type { ReadResult } from './backend';
import { pushOcrText } from './ocrLog';
import { sauvolaBinarize } from './scan';

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

/** Per-field winner across passes: highest confidence wins. Pure. */
export function mergeReads(reads: ReadResult[]): ReadResult {
  const out: ReadResult = {};
  for (const r of reads) for (const [k, v] of Object.entries(r)) {
    if (!v?.value) continue;
    if (!out[k]?.value || (v.confidence ?? 0) > (out[k]!.confidence ?? 0)) out[k] = v;
  }
  return out;
}

/** Multi-pass offline read: grey block, then B&W block, then sparse — vote per field. All on-device. */
export async function readOffline(photo: Blob, language = 'en', opts?: { silent?: boolean }): Promise<ReadResult> {
  const w = await getWorker(language);
  const pass = async (psm: number, bw: boolean) => {
    await w.setParameters({
      tessedit_pageseg_mode: psm as never,
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
    });
    const { data } = await w.recognize(await preprocessForOcr(photo, { bw }));
    const raw = (data as { text?: string })?.text ?? '';
    return { parsed: parseCardText(rebuildText(data as unknown as TesseractData) || raw), raw };
  };
  const p1 = await pass(6, false);
  const p2 = await pass(3, false).catch(() => null);
  const p3 = await pass(6, true).catch(() => null);
  const merged = mergeReads([p1.parsed, ...(p2 ? [p2.parsed] : []), ...(p3 ? [p3.parsed] : [])]);
  if (!opts?.silent) pushOcrText([p1.raw, p2?.raw, p3?.raw].filter(Boolean).join('\n---\n'), 'device Tesseract (multi-pass)');
  return merged;
}

/**
 * Upscale + normalise the photo for Tesseract: small print (emails, addresses) is often under
 * 30 px tall after SCAN-06 compression, and Tesseract reads 300 dpi best. In-memory only.
 * bw: Sauvola pass for faint print; always finished with a 10px white border (tight crops fail).
 */
async function preprocessForOcr(photo: Blob, opts?: { bw?: boolean }): Promise<Blob> {
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
    // Greyscale + adaptive stretch: stretch the sampled min/max to 0..255 with contrast boost
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    let lo = 255, hi = 0;
    for (let i = 0; i < d.length; i += 32) {
      const g = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
      if (g < lo) lo = g;
      if (g > hi) hi = g;
    }
    // Prevent over-stretching pure black/white
    lo = Math.max(0, lo - 5);
    hi = Math.min(255, hi + 5);
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      const g = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
      const v = Math.max(0, Math.min(255, ((g - lo) / span) * 255));
      d[i] = v; d[i + 1] = v; d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    let src = c;
    if (opts?.bw) {
      const g = new Float32Array(W * H);
      const done = ctx.getImageData(0, 0, W, H).data;
      for (let i = 0; i < W * H; i++) g[i] = 0.299 * done[i * 4]! + 0.587 * done[i * 4 + 1]! + 0.114 * done[i * 4 + 2]!;
      const bw = sauvolaBinarize(g, W, H);
      const bc = document.createElement('canvas');
      bc.width = W; bc.height = H;
      const bctx = bc.getContext('2d')!;
      const bout = bctx.createImageData(W, H);
      for (let i = 0; i < W * H; i++) {
        const v = bw[i]!;
        bout.data[i * 4] = v; bout.data[i * 4 + 1] = v; bout.data[i * 4 + 2] = v; bout.data[i * 4 + 3] = 255;
      }
      bctx.putImageData(bout, 0, 0);
      src = bc;
    }
    // 10px white border: Tesseract mis-segments text touching the image edge.
    const PAD = 10;
    const fin = document.createElement('canvas');
    fin.width = src.width + PAD * 2;
    fin.height = src.height + PAD * 2;
    const fctx = fin.getContext('2d')!;
    fctx.fillStyle = '#fff';
    fctx.fillRect(0, 0, fin.width, fin.height);
    fctx.drawImage(src, PAD, PAD);
    const out = await new Promise<Blob | null>((res) => {
      try { fin.toBlob((b) => res(b), 'image/jpeg', 0.92); } catch { res(null); }
    });
    return out ?? photo;
  } catch {
    return photo;
  }
}

interface TesseractWord { text: string; confidence: number; bbox?: { x0: number; y0: number; x1: number; y1: number } }
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
 * Join a line's words back into text, keeping a two-column card's gutter. The gutter only
 * survives as position — a gap wider than the type is tall is a column break, not a word
 * space — and parseCardText splits the columns on it, so the brand line stays the brand line.
 */
function joinGutter(words: TesseractWord[]): string {
  const tall = words.reduce((h, w) => (w.bbox ? Math.max(h, w.bbox.y1 - w.bbox.y0) : h), 0);
  let out = '';
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const prev = words[i - 1];
    if (prev) {
      const gap = w.bbox && prev.bbox ? w.bbox.x0 - prev.bbox.x1 : 0;
      out += tall > 0 && gap > tall ? '  ' : ' ';
    }
    out += cleanToken(w.text);
  }
  return out;
}

/**
 * Rebuild lines from Tesseract's words, dropping what the engine was unsure of and what is
 * decoration rather than text. Falls back to plain text when no word boxes came back.
 */
export function rebuildText(data: TesseractData): string {
  const lines = data?.lines;
  if (!lines?.length) return data?.text ?? '';
  const out: string[] = [];
  for (const line of lines) {
    const source = line.words?.length
      ? line.words.filter((w) => !WEAK_WORD(w))
      : [{ text: line.text, confidence: line.confidence }];
    const kept = source.filter((w) => cleanToken(w.text) && !DECORATION.test(cleanToken(w.text)));
    if (!kept.length) continue;
    const joined = joinGutter(kept).trim();
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
const TITLE = /\b(manager|director|head of|head|chief|ceo|cto|cfo|coo|chairman|chairwoman|evp|svp|avp|owner|proprietor|founder|partner|president|presidente|président|vice[- ]president|vp|lead|team leader|diretor|sales|marketing|purchas|procurement|export|import|commercial|comercial|vendedor|leiter(in)?|gesch[äa]ftsf[üu]hrer(in)?|gründer|vorstand|vertrieb|einkauf|directeur|directrice|fondateur|gérant|comptable|responsable|responsabile|respons[áa]vel|gerente|fundador|fondatore|jefe|encargado|propietario|contable|titolare|amministratore|consulente|sócio|socio|oprichter|eigenaar|verkoper|adviseur|director[ao]|inkoper|engineer|consultant|specialist|executive|representative|agronom|supervisor|foreman|coordinator|administrator|secretary|treasurer|trustee|governor|assistant|associate|dealer|distributor|retailer|wholesaler|supplier|vendor|contractor|builder|merchant|trader|farmer|freelancer|accountant|auditor|banker|broker|agent|advisor|adviser|analyst|designer|developer|architect|doctor|nurse|lawyer|advocate|writer|editor|journalist|photographer|artist|musician|actor|driver|coach|trainer|teacher|professor|lecturer|instructor|researcher|scientist|receptionist|clerk|cashier|intern|trainee|apprentice)/i;
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

/** Plain Levenshtein distance — for single-slip OCR repairs. Pure. */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/**
 * Repairs OCR slips in a company line against the website domain ("Ennich Spaces"
 * + enrichspaces.co.in → "Enrich Spaces"). Each long word missing from the domain
 * takes its closest domain substring (one slip, two for long words), keeping the
 * word's case pattern and position — the printed word breaks survive, only letters
 * change. Returns the line untouched when nothing is worth fixing. Pure: unit-tested.
 */
export function repairCompanySpelling(line: string, base: string): string {
  if (!base || domainScoreOf(line, base) >= 1) return line;
  let changed = false;
  const out = line.split(/(\s+)/).map((tok) => {
    if (!/[A-Za-z]/.test(tok) || tok.length < 4) return tok;
    const wl = tok.toLowerCase();
    if (base.includes(wl)) return tok;
    const allow = wl.length >= 7 ? 2 : 1;
    let best = '';
    let bestDist = Infinity;
    for (let len = Math.max(4, wl.length - 2); len <= wl.length + 2; len++) {
      for (let i = 0; i + len <= base.length; i++) {
        const sub = base.slice(i, i + len);
        const d = editDistance(wl, sub);
        if (d < bestDist) { bestDist = d; best = sub; }
      }
    }
    if (bestDist > allow || !best) return tok;
    changed = true;
    return /^[A-Z]+$/.test(tok.replace(/[^A-Za-z]/g, '')) ? best.toUpperCase()
      : best.charAt(0).toUpperCase() + best.slice(1);
  });
  return changed ? out.join('') : line;
}

/**
 * Name-shaped: 2–4 plain words ("Priya Nair", "Enrich Spaces"). Shared by the
 * person guard below — a public mailbox says nothing, so with gmail & friends
 * any name-shaped line is ambiguous and the company fallback abstains instead of
 * guessing. Pure: unit-tested.
 */
export function isNameShaped(line: string): boolean {
  const words = line.split(/\s+/).filter(Boolean);
  return words.length >= 2 && words.length <= 4
    && words.every((w) => /^[A-Za-z][\p{L}'’.-]*$/u.test(w));
}

/**
 * A name-shaped line that also matches the email local part ("Priya Nair" next to
 * priya.nair@…) belongs to the person — the company fallback must not steal it
 * before pickName runs. Only meaningful for company mail: with a public mailbox
 * the local part could be either side, so callers must check that first.
 * Pure: unit-tested.
 */
export function isPersonLine(line: string, emailLocal: string): boolean {
  if (!isNameShaped(line)) return false;
  const local = squashForSim(emailLocal);
  if (!local) return false;
  return line.split(/\s+/).some((w) => {
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

/** Lowercase or joining words inside a printed name: "Bank of Baroda", "ACME - RENEWABLES". */
const LOWER_NAME_WORD = /^(of|and|the|for|in|at|on|to|by|y|e|de|del|della|der|den|di|da|das|dos|du|van|von|ter|ten|le|la|el|al|bin|mac|mc|&|\+|-|–)$/i;
/** A line of instructions printed at the foot of a card is never the company. */
const PROMO = /^(scan|follow|connect|visit|call|contact|join|tap|download|subscribe|email|mail|write|reach|book|order)\b/i;

/**
 * Lines Tesseract read out of artwork rather than print — a logo mark, the QR code, the
 * skyline printed under the job title ("SORE [ores", "ExmOmt] oo ee jC EX §"). Two shapes
 * give it away: a bracket, rule or section sign still stuck to a word, and a run of
 * one/two-letter blips. Printed names are letters, "&", apostrophes and a dot. Pure.
 */
function isArtworkLine(l: string) {
  if (/[[\]{}<>~_=*§©®™^|\\]/.test(l)) return true;
  const words = l.split(/\s+/).filter(Boolean);
  const blips = words.filter((w) => w.replace(/[^A-Za-z0-9]/g, '').length <= 2).length;
  return words.length >= 3 && blips >= 2;
}

/**
 * Whether an evidence-free line is worth offering as the company. With no legal suffix and no
 * domain behind it, the line itself has to read like a printed name: a brand of several
 * capitalised words, or one long word ("AGRISOL"). Cards put that line anywhere — above the
 * name or in the footer under the address — so position decides nothing here. What it must
 * not be is artwork the engine spelled out ("SORE [ores") or a sentence-case tagline
 * ("Clarity in construction"). Pure: unit-tested.
 */
function isBrandGuess(l: string): boolean {
  if (isArtworkLine(l) || PROMO.test(l)) return false;
  const words = l.split(/\s+/).filter(Boolean);
  const letters = l.replace(/[^A-Za-z]/g, '');
  if (letters.length < 4) return false;
  if (words.length === 1) return letters.length >= 5;
  return words.every((w) => /^[\p{Lu}\p{N}]/u.test(w) || LOWER_NAME_WORD.test(w));
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
 * The words Tesseract glued to the front of an address because the icon beside it read as
 * letters: "SA carokiaswamy@…", "A carokiaswamy@…". A 1–3 character token with no lowercase
 * letter is the envelope mark, not the mailbox — it is dropped only when the address proper
 * starts lowercase, so an address printed in capitals ("JR SMITH@…") keeps all of itself.
 */
function trimIconPrefix(buf: string): string[] {
  const tokens = buf.split(/\s+/).filter(Boolean);
  let from = 0;
  while (tokens.length - from > 1 && /^[^a-z]{1,3}$/.test(tokens[from]!)) from++;
  if (from > 0 && !/^[a-z]/.test(tokens[from] ?? '')) from = 0;
  return tokens.slice(from);
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
    // A space that survives between real words of the local part means Tesseract lost the
    // print — the address is flagged. A dropped icon prefix is not a lost character.
    const parts = trimIconPrefix(buf);
    const local = parts.join('');
    const dm = text.slice(i + 1).match(/^[\w-]+(\.[\w-]+)+/);
    if (!dm || !local) continue;
    const cand = `${local}@${dm[0]}`;
    if (EMAIL.test(cand)) take(cand, parts.length > 1);
  }
  return best;
}

/** Best line for the person's name: 2 words and a lone initial beat logo fragments and debris. */
function pickName(lines: string[], used: Set<string>, emailLocal: string, domainBase = '', emailPublic = false): string | null {
  let best: string | null = null;
  let bestScore = -1;
  lines.forEach((l, idx) => {
    if (used.has(l) || /[@\d]/.test(l) || COMPANY.test(l) || TITLE.test(l)) return;
    const stripped = l.replace(/^((dr|prof|mr|mrs|ms|ing|dipl)\.?\s+)+/i, '');
    const words = stripped.split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 4) return;
    if (!words.every((w) => /^[A-Za-z][\p{L}'’.-]*$/u.test(w))) return;
    if (stripped.replace(/[^A-Za-z]/g, '').length < 3) return;
    // Person proof first: a line matching the email local part is the person even
    // when it also contains the domain ("Arokiaswamy" in christian@arokia.in).
    let m = 0;
    if (emailLocal) {
      const el = squashForSim(emailLocal);
      for (const w of words) {
        const sq = squashForSim(w);
        if (sq.length >= 3 && (el.includes(sq) || bigramSim(sq, el) >= 0.7)) m++;
      }
    }
    // Cross-check: a line that IS the email domain is the company, never the person.
    if (m === 0 && domainBase && domainScoreOf(l, domainBase) >= 0.75) return;
    let s = 0;
    if (/^[A-Z]/.test(words[0]!)) s += 2;
    if (words.length === 2) s += 2;
    else if (words.length === 3) s += 1;
    if (/^[A-Z]\.?$/.test(words[words.length - 1]!)) s += 2; // a lone initial: "Jayakumar P"
    if (emailLocal) {
      // A public mailbox only whispers: companyname@gmail.com and personname@gmail.com
      // look identical, so its local part may break a shape tie but never outvote shape.
      s += emailPublic ? (m > 0 ? 1 : 0) : Math.min(m, 2) * 2;
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
  // Numbers glued with a comma or slash ("M: +91 …, +91 …") each count, and any
  // further distinct number gets its own slot (phone2, phone3) so none is lost.
  interface PhoneCand { line: string; value: string; digits: string; mobile: boolean; repairedCC: boolean; indiaDefaulted: boolean }
  const cands: PhoneCand[] = [];
  for (const l of lines.filter((x) => PHONE_CHARS.test(x.replace(/(\d)\s*[Bb]\s*(\d)/g, '$1 8 $2')) && !x.includes('@') && !FAX.test(x))) {
    // B-for-8 happens before the match, otherwise the digit run never matches ("+91 B424015630").
    const norm = l.replace(/(\d)\s*[Bb]\s*(\d)/g, '$1 8 $2');
    for (const m of norm.matchAll(new RegExp(PHONE_CHARS.source, 'g'))) {
      const value = repairPhone(m[1]);
      const digits = value.replace(/\D/g, '');
      if (digits.length < 7) continue; // a mangled fragment, not a number — leave it for the person
      cands.push({ line: l, value, digits, mobile: MOBILE_LABEL.test(l) || MISREAD_MOBILE.test(l) || MOBILE_INITIAL.test(l), repairedCC: false, indiaDefaulted: false });
    }
    if (cands.some((c) => c.line === l)) used.add(l);
  }
  // A digit Tesseract dropped ("; +9) 8424015630" for +91 …): borrow the calling code from a
  // sibling number on the same card rather than storing a number with no country.
  const knownCCs = new Set(cands.map((c) => ccOf(c.digits)).filter((c): c is string => c !== null));
  // A bare 10-digit mobile starting 6–9 is not a dropped digit when the card is Indian
  // (a +91 sibling, or India printed on it) — the loop below must not eat its first
  // digit; it gets +91 afterwards. Anything else stays exactly as printed.
  const indiaContext = /india/i.test(fixed) || knownCCs.has('91');
  for (const c of cands) {
    if (ccOf(c.digits) || c.digits.length < 10) continue;
    if (c.digits.length === 10 && /^[6-9]/.test(c.digits) && indiaContext) continue;
    for (const sib of knownCCs) {
      if (c.digits.startsWith(sib.charAt(0)) && c.digits.slice(1).length >= 8 && c.digits.slice(1).length <= 12) {
        c.value = `+${sib}${c.digits.slice(1)}`;
        c.digits = `${sib}${c.digits.slice(1)}`;
        c.repairedCC = true;
        break;
      }
    }
  }
  for (const c of cands) {
    if (!ccOf(c.digits) && c.digits.length === 10 && /^[6-9]/.test(c.digits) && indiaContext) {
      c.value = `+91 ${c.digits}`;
      c.digits = `91${c.digits}`;
      c.indiaDefaulted = true;
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
    if (pick.indiaDefaulted) {
      conf = Math.min(conf, 0.65);
      reason ??= 'No country code on the card — assumed India from context';
    } else if (pick.repairedCC || !ccOf(pick.digits)) {
      conf = Math.min(conf, 0.65);
      reason ??= 'Repaired a misread digit — check the number';
    }
    if (national(pick.digits).length < 9) {
      conf = Math.min(conf, 0.5);
      reason ??= 'This number looks incomplete.';
    }
    out.phone = mark(pick.value, conf, reason);
    used.add(pick.line);
    // Every further distinct number gets its own slot — the card printed it, so it is kept.
    const seen = new Set([pick.digits]);
    const extras = cands.filter((c) => {
      if (c === pick || seen.has(c.digits)) return false;
      seen.add(c.digits);
      return true;
    });
    (['phone2', 'phone3'] as const).forEach((key, i) => {
      const extra = extras[i];
      if (extra) out[key] = mark(extra.value, 0.65, 'Another number from the same card — check which is which');
    });
  }

  // Website, or the email's domain when the card only prints an address.
  // Note: the check is “no email address”, not “no @” — OCR debris such as
  // “@&: www.wetano.com” carries a stray @ next to the real URL.
  const webLine = lines.find((l) => !EMAIL.test(l) && WEB.test(l) && /(www\.|https?:|\.(com|de|fr|it|es|nl|pt|eu|se|dk|no|fi|at|ch|be|ie|in|co\.uk|net|org))/i.test(l));
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
  // Printed beats guessed — the word is right there, so it is not uncertain.
  const countryLine = lines.find((l) => COUNTRY.test(l));
  if (countryLine) {
    const foundCountry = countryLine.match(COUNTRY)![0];
    out.country = mark(foundCountry.charAt(0).toUpperCase() + foundCountry.slice(1), 0.9);
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
  const emailPublic = !!emailDomain && isFreeMailDomain(emailDomain);
  const domainBase = emailDomain && !emailPublic ? domainBaseOf(emailDomain) : '';
  const webHost = webPrinted?.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0] ?? '';
  const siteBase = webHost && !isFreeMailDomain(webHost) ? domainBaseOf(webHost) : '';
  let company: string | null = hard[0] ?? soft[0] ?? null;
  let companyWhy: 'suffix' | 'site' | 'domain' | 'top' | null = company ? 'suffix' : null;
  if (!company) {
    const cands = lines.filter((l) => !used.has(l) && !/[@\d]/.test(l) && !TITLE.test(l));
    const agreeIn = (pool: string[], base: string) => pool
      .map((l) => ({ l, s: domainScoreOf(l, base) }))
      .sort((a, b) => b.s - a.s)
      .find((r) => r.s >= 0.55)?.l ?? null;
    // The website is independent evidence — consulted over every candidate, even
    // name-shaped ones the email step below must abstain on.
    const siteHit = siteBase ? agreeIn(cands, siteBase) : null;
    // Email evidence only when the mailbox belongs to a company. A public mailbox
    // poisons this step either way (companyname@gmail.com and personname@gmail.com
    // look identical), so name-shaped lines abstain entirely rather than coin-flip.
    const screened = emailPublic
      ? cands.filter((l) => !isNameShaped(l))
      : cands.filter((l) => !isPersonLine(l, emailLocal));
    const mailHit = !siteHit && domainBase ? agreeIn(screened, domainBase) : null;
    // No suffix and no domain: the line itself has to read like a printed name, wherever the
    // card puts it. Artwork and taglines are rejected on their own shape, not their position.
    const guess = screened.find((l) => isBrandGuess(l)) ?? null;
    company = siteHit ?? mailHit ?? guess;
    companyWhy = siteHit ? 'site' : mailHit ? 'domain' : company ? 'top' : null;
  }
  if (company && lines.includes(company)) {
    // A letterhead often splits the name over two lines: “NORDSAAT” above “Saatgut GmbH”,
    // or a CamelCase brand (“WeTano”) above “Solutions Private Limited”. The brand line
    // carries no legal suffix, so the suffix search leaves it behind — prepend it when it
    // is short, unused, not the person, and either all-caps or agreeing with the domain.
    // Two-column cards put the right-column header between brand and legal name
    // (“WeTano” / “Headquarters” / “Solutions Private Limited”), so look past one
    // skippable header line when the direct neighbour does not qualify.
    const idx = lines.indexOf(company);
    const base = siteBase || domainBase;
    const brandLike = (cand: string) =>
      cand && !used.has(cand) && cand.split(/\s+/).length <= 3 && !/[@\d]/.test(cand)
      && !TITLE.test(cand) && !COMPANY.test(cand) && !isPersonLine(cand, emailLocal)
      // A location header ("Headquarters") is never the brand — it only sits between it and the legal name.
      && !/headquarters|head office|registered|corporate|branch/i.test(cand)
      && (cand === cand.toUpperCase()
        || (base !== '' && domainScoreOf(cand, base) >= 0.75)
        || /^[A-Z][A-Za-z]+$/.test(cand));
    const above = lines[idx - 1];
    if (above && brandLike(above)) {
      company = `${above} ${company}`;
      used.add(above);
      used.add(lines[idx]!);
    } else if (idx >= 2 && above && /headquarters|^[^\p{L}\d]+/iu.test(above)) {
      const higher = lines[idx - 2]!;
      if (higher && brandLike(higher)) {
        company = `${higher} ${company}`;
        used.add(above);
        used.add(higher);
        used.add(lines[idx]!);
      }
    }
  }
  if (company) {
    const hardWon = hard.includes(company) || (company.includes(' ') && hard.some((h) => company!.includes(h)));
    let value = company;
    let conf = hardWon ? 0.85 : companyWhy === 'site' ? 0.8 : companyWhy === 'domain' ? 0.75 : 0.5;
    let reason = hardWon ? undefined
      : companyWhy === 'site' ? 'Matches the website address'
      : companyWhy === 'domain' ? 'Matches the email address' : 'No legal suffix on the card — check the company name';
    if (!hardWon && companyWhy === 'site' && siteBase) {
      // The logo read is often the misread one — the website domain spells it right.
      const fixed = repairCompanySpelling(company, siteBase);
      if (fixed !== company) {
        value = fixed;
        conf = 0.75;
        reason = 'Spelling fixed from the website address';
      }
    }
    out.company = mark(value, conf, reason);
    used.add(company);
  }

  // Job title. Stray glyphs from the card's rules land on this line ("Manager ©/C/Ar.").
  // A TITLE match on its own line is read, not guessed — no "please check" for it.
  const titleLine = lines.find((l) => TITLE.test(l) && !used.has(l));
  if (titleLine) {
    let title = clean(titleLine).replace(/\s*[©®™]+$/u, '').replace(/\s+[•·|_—–\-=:;.]+$/u, '');
    if (title.split(/\s+/).length >= 3) title = title.replace(/\s[A-Za-z]\.?$/u, '').replace(/\s[A-Za-z]{2}\.$/u, '');
    out.job_title = mark(title, 0.85);
    used.add(titleLine);
  }

  // Name: scored, not first-match — "ayakumar P" (lowercased by a misread) still beats debris.
  // “Dr. Katharina Vogel” → the honorific is dropped, “Katharina” / “Vogel”.
  const nameLine = pickName(lines, used, emailLocal, siteBase || domainBase, emailPublic);
  if (nameLine) {
    const [first, last] = splitName(nameLine);
    if (first && last) {
      // A name the email address confirms (“Janakiraman” in janakiraman@…) is read,
      // not guessed — no “please check” for it. A public mailbox only whispers
      // (companyname@gmail.com and personname@gmail.com look identical), so it
      // never confirms.
      const el = squashForSim(emailLocal);
      const confirmed = !emailPublic && el !== '' && nameLine.split(/\s+/).some((w) => {
        const sq = squashForSim(w);
        return sq.length >= 3 && el.includes(sq);
      });
      const conf = confirmed ? 0.9 : 0.75;
      out.first_name = mark(first, conf);
      out.last_name = mark(last, conf);
    }
  } else if (email && !emailPublic) {
    // Last resort: many company addresses are first.last@… — but never from a
    // public mailbox, where the local part could be either side.
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

  // Address: street + postcode lines, joined in card order. A 6-digit PIN anchors an
  // address on its own (certain enough to not flag); a 5-digit postcode needs a street
  // marker or comma beside it (so years and order numbers never qualify), and fax
  // lines are never addresses.
  const PINCODE = /\b[1-9]\d{5}\b/;
  const POSTCODE5 = /\b\d{5}\b/;
  const STREET = /\b(stra[sß]e|strasse|str\.|platz|weg|gasse|allee|ring|ufer|rue|avenue|av\.|boulevard|bd\.|impasse|chemin|place|quai|route|via|viale|piazza|corso|vicolo|largo|calle|avenida|plaza|paseo|carrer|camino|straat|laan|plein|kade|dijk|singel|weg|rua|travessa|praca|praça|street|st\.|road|rd\.|lane|drive|park|square|suite|floor|unit|nagar|marg|gali|colony|layout|enclave|vihar|puram|cross|main|plot|highway)(?![A-Za-z])/i;
  const scored = lines.filter((l) => {
    // The country line often IS the address tail — it stays eligible here.
    if ((used.has(l) && l !== countryLine) || l.includes('@') || FAX.test(l)) return false;
    let s = 0;
    if (PINCODE.test(l)) s += 3;
    else if (POSTCODE5.test(l) && (STREET.test(l) || l.includes(','))) s += 2;
    if (STREET.test(l)) s += 2;
    if (/\d/.test(l)) s += 1;
    return s >= 3;
  });
  // A locality line ("Queenspark, Saligramam") carries no postcode, street word or
  // digits, so it never scores — yet right above a PIN line it is the address head.
  // Pull in up to two such comma lines above the first hit.
  const addrLines = [...scored];
  if (scored.length) {
    const top = lines.indexOf(scored[0]!);
    for (let i = top - 1; i >= Math.max(0, top - 2) && addrLines.length < 3; i--) {
      const l = lines[i]!;
      if ((used.has(l) && l !== countryLine) || l.includes('@') || FAX.test(l)) break;
      if (/[@\d]/.test(l) || TITLE.test(l) || COMPANY.test(l) || !l.includes(',')) break;
      if (isPersonLine(l, emailLocal)) break;
      addrLines.unshift(l);
    }
  }
  const picked = addrLines.slice(0, 3);
  if (picked.length) {
    const hasPin = picked.some((l) => PINCODE.test(l));
    out.address = mark(picked.map((l) => l.replace(/,\s*$/, '')).join(', '), hasPin ? 0.85 : 0.55,
      hasPin ? undefined : 'No postcode on the card — check the address');
    picked.forEach((l) => used.add(l));
  }

  return out;
}
