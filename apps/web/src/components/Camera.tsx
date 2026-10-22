import { useEffect, useRef, useState } from 'preact/hooks';
import { CameraOff, SwitchCamera, Zap, ZapOff } from 'lucide-preact';
import { analyseFrame, burstCrop, frameRect, isGlare, motion, placement, sharpness } from '../lib/image';
import { t } from '../lib/i18n';

export interface CameraHandle { capture: () => void }

interface Props {
  active: boolean;
  onCapture: (shot: HTMLCanvasElement) => void;
  handle?: (h: CameraHandle) => void;
  autoCapture?: boolean;
}

const SAMPLE_W = 160;
const SAMPLE_H = 100;
const STEADY_FRAMES = 4; // ~1 s at 250 ms
const MOTION_MAX = 6;
const SHARP_MIN = 90;

/** QR codes and badge barcodes, where the browser can read them (Chrome, Android). */
type Detector = { detect: (s: CanvasImageSource) => Promise<unknown[]> };
const newBarcodeDetector = (): Detector | null => {
  const B = (globalThis as { BarcodeDetector?: new (o?: { formats?: string[] }) => Detector }).BarcodeDetector;
  if (!B) return null;
  try {
    return new B({ formats: ['qr_code', 'data_matrix', 'pdf417', 'aztec', 'code_128'] });
  } catch {
    return null;
  }
};

/**
 * Live camera with a card frame; captures automatically when the card is steady and sharp (SCAN-01).
 * Works with phone cameras and laptop webcams; camera picker when there is more than one (§5.5).
 */
export function Camera({ active, onCapture, handle, autoCapture = true }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(() => localStorage.getItem('wetasnap-camera'));
  const [hint, setHint] = useState<'find' | 'blank' | 'far' | 'hold' | 'blur' | 'glare' | 'ready'>('find');
  const [flash, setFlash] = useState(false);
  const [torch, setTorch] = useState(false);
  const [torchOk, setTorchOk] = useState(false);
  const onCap = useRef(onCapture);
  onCap.current = onCapture; // the auto-capture interval must always call the latest handler

  const capture = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    setFlash(true);
    setTimeout(() => setFlash(false), 180);
    navigator.vibrate?.(30);
    // Burst: 3 frames ~220ms apart, keep the sharpest — handshake blur is the top misread cause.
    void burstCrop(v, frameRect(v.videoWidth, v.videoHeight)).then((shot) => onCap.current(shot));
  };
  useEffect(() => handle?.({ capture }));

  // Start / stop the stream.
  useEffect(() => {
    if (!active) return;
    let stream: MediaStream | null = null;
    let cancelled = false;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          // Sensor's best: the guide crop is downscaled to 1600 px, so more source
          // pixels means a sharper card (supersampling, not blur).
          video: deviceId
            ? { deviceId: { exact: deviceId }, width: { ideal: 3840 }, height: { ideal: 2160 } }
            : { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
        });
        if (cancelled) { stream.getTracks().forEach((tr) => tr.stop()); return; }
        if (video.current) {
          video.current.srcObject = stream;
          await video.current.play().catch(() => {});
        }
        setError(null);
        setTorchOk(!!(stream.getVideoTracks()[0]?.getCapabilities?.() as { torch?: boolean } | undefined)?.torch);
        const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
        setDevices(all);
      } catch (e) {
        const name = (e as DOMException).name;
        if (name === 'OverconstrainedError' && deviceId) { localStorage.removeItem('wetasnap-camera'); setDeviceId(null); return; }
        setError(name === 'NotAllowedError' ? t('Camera permission was denied. Allow camera access in your browser settings, or use Upload / Type.')
          : name === 'NotFoundError' || (e as Error).message === 'unsupported' ? t('No camera found. Use Upload or Type instead.')
          : t('The camera could not start. Use Upload or Type instead.'));
      }
    })();
    return () => { cancelled = true; stream?.getTracks().forEach((tr) => tr.stop()); };
  }, [active, deviceId]);

  // Auto-capture loop: steady + sharp for ~1 s inside the frame.
  useEffect(() => {
    if (!active || !autoCapture) return;
    const c = document.createElement('canvas');
    c.width = SAMPLE_W; c.height = SAMPLE_H;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    let prev: Uint8ClampedArray | null = null;
    let steady = 0;
    let cooldown = 0;
    // A QR code or a badge barcode counts as “properly placed” on its own: those are often on
    // lanyards and busy badges that no flat-card test would accept.
    const barcodes = newBarcodeDetector();
    let code = false;
    let looking = false;
    const id = setInterval(() => {
      const v = video.current;
      if (!v || !v.videoWidth || document.hidden) return;
      if (cooldown > 0) { cooldown--; return; }
      const r = frameRect(v.videoWidth, v.videoHeight);
      ctx.drawImage(v, r.x, r.y, r.w, r.h, 0, 0, SAMPLE_W, SAMPLE_H);
      if (barcodes && !looking) {
        looking = true;
        void barcodes.detect(c).then((found) => { code = found.length > 0; })
          .catch(() => { code = false; })
          .finally(() => { looking = false; });
      }
      const px = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
      const sharp = sharpness(px, SAMPLE_W, SAMPLE_H);
      const still = prev ? motion(prev, px) < MOTION_MAX : false;
      prev = px.slice();

      // Only a card, badge or code that fills the guide is worth a photo — never a desk or a hand.
      const where = code ? 'ok' : placement(analyseFrame(px, SAMPLE_W, SAMPLE_H));
      if (where !== 'ok') { steady = 0; setHint(where === 'none' ? 'find' : where); return; }
      if (!still) { steady = 0; setHint('hold'); return; }
      if (sharp < SHARP_MIN) { steady = 0; setHint('blur'); return; }
      if (isGlare(px, SAMPLE_W, SAMPLE_H)) { steady = 0; setHint('glare'); return; }
      steady++;
      setHint('ready');
      if (steady >= STEADY_FRAMES) { steady = 0; cooldown = 12; code = false; capture(); }
    }, 250);
    return () => clearInterval(id);
  }, [active, autoCapture]);

  if (error)
    return (
      <div class="flex h-full min-h-64 flex-col items-center justify-center gap-3 bg-slate-900 p-6 text-center text-white">
        <CameraOff class="size-10 text-white/60" />
        <p class="max-w-xs text-sm text-white/90">{error}</p>
      </div>
    );

  async function setTorchOn(on: boolean) {
    const tr = (video.current?.srcObject as MediaStream | null)?.getVideoTracks()[0];
    try {
      await tr?.applyConstraints({ advanced: [{ torch: on } as Record<string, unknown>] });
      setTorch(on);
    } catch { /* torch unsupported on this camera */ }
  }

  const hintText = {
    find: t('Place the card inside the frame'),
    blank: t('Nothing to read yet — a card, badge or QR code, please'),
    far: t('Move closer so the card fills the frame'),
    hold: t('Hold steady…'),
    blur: t('Too blurry — move a little closer or add light'),
    glare: t('Too shiny — tilt the card a little'),
    ready: t('Capturing…'),
  }[hint];

  return (
    <div class="relative h-full min-h-64 overflow-hidden bg-slate-900">
      <video ref={video} class="absolute inset-0 size-full object-cover" playsInline muted autoPlay />
      {/* Card frame overlay (ID-1 ratio) */}
      <div class="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div class={`relative aspect-[85.6/54] w-[82%] max-h-[82%] rounded-2xl shadow-[0_0_0_9999px_rgba(15,23,42,0.45)] transition ${hint === 'ready' ? 'ring-4 ring-brand-500' : 'ring-2 ring-white/80'}`}>
          {(['top-0 left-0 border-t-4 border-l-4 rounded-tl-2xl', 'top-0 right-0 border-t-4 border-r-4 rounded-tr-2xl', 'bottom-0 left-0 border-b-4 border-l-4 rounded-bl-2xl', 'bottom-0 right-0 border-b-4 border-r-4 rounded-br-2xl'] as const).map((c) => (
            <span key={c} class={`absolute size-7 ${c} ${hint === 'ready' ? 'border-brand-500' : 'border-ocean-500'}`} />
          ))}
        </div>
      </div>
      <p class={`absolute inset-x-0 bottom-4 mx-auto w-fit rounded-full px-3 py-1 text-xs font-semibold backdrop-blur ${hint === 'blur' || hint === 'glare' ? 'bg-amber-400/90 text-amber-950' : 'bg-black/50 text-white'}`}>{hintText}</p>
      <div class="absolute top-3 right-3 flex items-center gap-2">
      {torchOk && (
        <button class="flex size-11 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur" onClick={() => void setTorchOn(!torch)} aria-label={t('Flash')}>
          {torch ? <Zap class="size-5" /> : <ZapOff class="size-5" />}
        </button>
      )}
      {devices.length > 1 && (
        <label class="flex items-center gap-1 rounded-full bg-black/50 py-1 pr-1 pl-2.5 text-white backdrop-blur">
          <SwitchCamera class="size-4" />
          <select class="max-w-40 bg-transparent py-1 text-xs font-medium outline-none" aria-label={t('Camera')} value={deviceId ?? ''}
            onChange={(e) => { const id = e.currentTarget.value; localStorage.setItem('wetasnap-camera', id); setDeviceId(id || null); }}>
            <option value="" class="text-ink">{t('Default camera')}</option>
            {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId} class="text-ink">{d.label || `${t('Camera')} ${i + 1}`}</option>)}
          </select>
        </label>
      )}
      </div>
      {flash && <div class="absolute inset-0 bg-surface/70" />}
    </div>
  );
}
