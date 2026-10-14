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

const clean = (v: string) => v.replace(/\s+/g, ' ').trim().replace(/[,;|]+$/, '');

/** Rule lines and OCR debris ("ee ——", "Ld", "3 J"): fewer than 3 letters/digits, or a long rule with no real words. */
function isDebris(l: string) {
  if (l.replace(/[^A-Za-z0-9]/g, '').length < 3) return true;
  if (/([—–\-_=|:.])\1{3,}/.test(l)) {
    return l.split(/\s+/).filter((w) => /[A-Za-z0-9]{3,}/.test(w)).length <= 1;
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
  s = s.replace(/[()]/g, ''); // "+9) 8424015630"
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
function pickName(lines: string[], used: Set<string>, emailLocal: string): string | null {
  let best: string | null = null;
  let bestScore = -1;
  lines.forEach((l, idx) => {
    if (used.has(l) || /[@\d]/.test(l) || COMPANY.test(l) || TITLE.test(l)) return;
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
      const el = emailLocal.toLowerCase();
      let m = 0;
      for (const w of words) if (w.length >= 3 && el.includes(w.toLowerCase())) m++;
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
  // Two-column cards arrive as merged "email   Company" lines (the gutter survives as extra
  // spaces via preserve_interword_spaces). Split them back into one fact per line first.
  const lines = text
    .split('\n')
    .flatMap((l) => l.split(/\t| {2,}/))
    .map((l) => clean(l))
    .filter((l) => l.length > 1 && !LABEL.test(l) && !isDebris(l) && looksLikeText(l));
  const out: ReadResult = {};
  const mark = (value: string, confidence: number, reason?: string) => ({ value, confidence, reason, by: 'offline' as const });
  const used = new Set<string>();

  // Email — the most reliable thing on a card.
  const found = extractEmail(text);
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
  let company = hard[0] ?? soft[0]
    ?? lines.find((l) => !used.has(l) && !/[@\d]/.test(l) && !TITLE.test(l));
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
    out.company = mark(company, hard[0] !== undefined || soft.length ? (hardWon ? 0.8 : 0.5) : 0.5,
      hardWon ? undefined : 'Taken from the top of the card');
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
  const nameLine = pickName(lines, used, email?.split('@')[0] ?? '');
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

  return out;
}
