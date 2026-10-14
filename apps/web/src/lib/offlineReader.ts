import type { ReadResult } from './backend';
import { pushOcrText } from './ocrLog';

/**
 * Reading a card on the device itself (AI-05): Tesseract runs in the browser, so a card can be
 * read with no server, no cloud account and no cost. It is the last link in the chain — the
 * company's own OCR service first, then the cloud reader, then this.
 *
 * The language data is fetched once per language and cached by the browser, so only the languages
 * actually needed are downloaded: the company's own, plus English (most cards carry some English).
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
    w = import('tesseract.js').then((T) => T.createWorker(langs));
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
  const { data } = await w.recognize(photo);
  // OCR-LOG: popup shows this raw Tesseract text right after the scan (silent for background re-reads).
  if (!opts?.silent) pushOcrText(data.text ?? '', 'device Tesseract');
  return parseCardText(data.text);
}

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
const PHONE_CHARS = /(\+?\d[\d\s()./-]{7,}\d)/;
const WEB = /\b((?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?:\/\S*)?\b/i;
const COMPANY = /\b(GmbH|AG|SAS|SARL|S\.?r\.?l\.?|S\.?p\.?A\.?|SL|S\.?A\.?|B\.?V\.?|N\.?V\.?|Lda|Ltd|Limited|LLC|Inc|Pvt|KG|AB|OY|A\/S|ApS|Co\.?|Group|Holding|Saatgut|Agritech)\b/i;
const TITLE = /\b(manager|director|head of|head|chief|ceo|cto|cfo|coo|owner|founder|partner|president|vice[- ]president|vp|sales|marketing|purchas|procurement|export|import|leiter(in)?|gesch[äa]ftsf[üu]hrer(in)?|vertrieb|einkauf|directeur|directrice|responsable|responsabile|gerente|director[ao]|inkoper|engineer|consultant|specialist|executive|representative|agronom)/i;
/** Lines that are labels rather than content. */
const LABEL = /^(tel|telephone|telefon|phone|mobile|mob|handy|cell|fax|e-?mail|mail|web|www|address|adresse)\b[:.\s-]*$/i;
const PHONE_LABEL = /\b(tel|telefon|phone|mobile|mob\.?|handy|cell|m|t)\b[:.\s-]*/i;
const FAX = /\bfax\b/i;
/** “Am Schwabeplan 8, 39164 Magdeburg, Germany” — the last part is usually the country. */
const COUNTRY = /\b(germany|deutschland|france|italy|italia|spain|espa[ñn]a|netherlands|nederland|portugal|belgium|austria|[öo]sterreich|switzerland|schweiz|sweden|denmark|norway|finland|poland|ireland|united kingdom|uk|england|india|usa|united states)\b/i;

const clean = (v: string) => v.replace(/\s+/g, ' ').trim().replace(/[,;|]+$/, '');

/**
 * Turn the lines Tesseract read into card fields. It is a best guess and every value lands in the
 * form for the person to check — which is why each carries a confidence (SCAN-04).
 */
export function parseCardText(text: string): ReadResult {
  const lines = text.split('\n').map((l) => clean(l)).filter((l) => l.length > 1 && !LABEL.test(l));
  const out: ReadResult = {};
  const mark = (value: string, confidence: number, reason?: string) => ({ value, confidence, reason, by: 'offline' as const });
  const used = new Set<string>();

  // Email — the most reliable thing on a card.
  const email = text.match(EMAIL)?.[0];
  if (email) {
    out.email = mark(email.toLowerCase().replace(/^[.,;:]+|[.,;:]+$/g, ''), 0.9);
    used.add(lines.find((l) => EMAIL.test(l)) ?? '');
  }

  // Phone: prefer a line that names itself (Tel/Mobile), and never a fax number.
  const phoneLines = lines.filter((l) => PHONE_CHARS.test(l) && !EMAIL.test(l) && !FAX.test(l));
  const phoneLine = phoneLines.find((l) => PHONE_LABEL.test(l) || l.includes('+')) ?? phoneLines[0];
  const phone = phoneLine?.match(PHONE_CHARS)?.[1];
  if (phone) {
    const others = phoneLines.length > 1;
    out.phone = mark(clean(phone), others ? 0.7 : 0.8, others ? 'More than one number on the card — check this is the right one' : undefined);
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

  // Country, from the address line.
  const countryLine = lines.find((l) => COUNTRY.test(l));
  if (countryLine) {
    const found = countryLine.match(COUNTRY)![0];
    out.country = mark(found.charAt(0).toUpperCase() + found.slice(1), 0.7);
  }

  // Company: a legal form wins; otherwise the first line, which is usually the letterhead.
  const companyLine = lines.find((l) => COMPANY.test(l) && !used.has(l) && !EMAIL.test(l));
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

  // Job title.
  const titleLine = lines.find((l) => TITLE.test(l) && !used.has(l));
  if (titleLine) { out.job_title = mark(titleLine, 0.7); used.add(titleLine); }

  // Name: two to four capitalised words, no digits, that is not the company or the title.
  // “Dr. Katharina Vogel” → the honorific is dropped, “Katharina” / “Vogel”.
  const nameLine = lines.find((l) => !used.has(l) && !/[@\d]/.test(l)
    && /^((dr|prof|mr|mrs|ms|ing|dipl)\.?\s+)?([A-ZÀ-Ý][\p{L}'’-]+[\s.]+){1,3}[A-ZÀ-Ý][\p{L}'’-]+$/u.test(l));
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
