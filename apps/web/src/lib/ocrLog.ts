/** Live OCR log — raw Tesseract text shown in a popup right after a scan. */
export interface OcrLogEntry {
  id: number;
  at: string;
  /** Where the text came from (device Tesseract vs server/cloud reader). */
  source: string;
  text: string;
}

let seq = 0;
let last: OcrLogEntry | null = null;
const listeners = new Set<(e: OcrLogEntry) => void>();

/** Record raw OCR text and notify live popups. Empty text is kept (shows "nothing read"). */
export function pushOcrText(text: string, source: string): OcrLogEntry {
  const entry: OcrLogEntry = { id: ++seq, at: new Date().toISOString(), source, text: text ?? '' };
  last = entry;
  for (const fn of [...listeners]) {
    try { fn(entry); } catch { /* never break scanning for a log listener */ }
  }
  return entry;
}

export function subscribeOcrLog(fn: (e: OcrLogEntry) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function lastOcrEntry(): OcrLogEntry | null {
  return last;
}
