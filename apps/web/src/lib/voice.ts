/** Voice notes (SCAN: notes can be dictated). Uses the browser's own speech recognition —
 *  no package, no upload: Chrome on Android and Safari on iPhone both support it. */
type Rec = {
  lang: string; continuous: boolean; interimResults: boolean;
  start(): void; stop(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

const Ctor = (): (new () => Rec) | undefined =>
  (window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec }).SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: new () => Rec }).webkitSpeechRecognition;

export const voiceSupported = () => typeof window !== 'undefined' && !!Ctor();

export interface VoiceSession { stop: () => void }

/** Calls `onText` with the text so far (interim included) until `stop()` is called. */
export function dictate(lang: string, onText: (text: string, final: boolean) => void, onError: (msg: string) => void): VoiceSession {
  const C = Ctor();
  if (!C) { onError('This browser cannot listen. Type the note instead.'); return { stop: () => {} }; }
  const rec = new C();
  rec.lang = lang;
  rec.continuous = true;
  rec.interimResults = true;
  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]!;
      const txt = r[0]?.transcript ?? '';
      if (r.isFinal) finalText += txt;
      else interim += txt;
    }
    onText((finalText + interim).trim(), false);
  };
  rec.onerror = (e) => onError(
    e.error === 'not-allowed' ? 'Microphone access was denied. Allow it in your browser settings.'
      : e.error === 'no-speech' ? 'Nothing was heard. Try again closer to the microphone.'
      : 'Dictation stopped. Type the note instead.');
  rec.onend = () => onText(finalText.trim(), true);
  try { rec.start(); } catch { onError('Dictation could not start.'); }
  return { stop: () => { try { rec.stop(); } catch { /* already stopped */ } } };
}

/** Speech-recognition language tag for the company's interface language. */
export const voiceLang = (lang: string) =>
  ({ en: 'en-GB', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', nl: 'nl-NL', pt: 'pt-PT' } as Record<string, string>)[lang] ?? 'en-GB';
