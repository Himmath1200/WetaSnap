import { useEffect, useRef, useState } from 'preact/hooks';
import { CameraOff, SwitchCamera, Zap, ZapOff } from 'lucide-preact';
import { motion, sharpness } from '../lib/image';
import { detectCard, engineState, onEngineState, quadsClose, warmEngine, type Quad } from '../lib/scanEngine';
import { t } from '../lib/i18n';

export interface DocShot { canvas: HTMLCanvasElement; quad: Quad | null }

interface Props {
  active: boolean;
  autoCapture?: boolean;
  onShot: (shot: DocShot) => void;
  handle?: (h: { capture: () => void }) => void;
}

const SAMPLE_W = 160;
const SAMPLE_H = 100;
const STEADY_FRAMES = 4; // ~2 s at 500 ms — a warp needs a steadier hand than a crop
const MOTION_MAX = 6;
const SHARP_MIN = 90;

/**
 * SCAN-V2 · live document camera. While the engine loads it behaves like a plain
 * viewfinder; once OpenCV + jscanify are ready it outlines the card live (CamScanner
 * style) and fires automatically when the outline sits still and sharp.
 */
export function DocCamera({ active, autoCapture = true, onShot, handle }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(() => localStorage.getItem('wetasnap-camera'));
  const [torch, setTorch] = useState(false);
  const [torchOk, setTorchOk] = useState(false);
  const [engine, setEngine] = useState(engineState());
  const [quad, setQuad] = useState<Quad | null>(null);
  const [view, setView] = useState({ w: 0, h: 0 });
  const [hint, setHint] = useState<'engine' | 'find' | 'hold' | 'blur' | 'ready'>('engine');
  const [flash, setFlash] = useState(false);
  const shot = useRef(onShot);
  shot.current = onShot;
  const quadRef = useRef<Quad | null>(null);
  quadRef.current = quad;

  useEffect(() => warmEngine(), []);
  useEffect(() => onEngineState(setEngine), []);
  useEffect(() => handle?.({ capture }), []);

  const capture = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    setFlash(true);
    setTimeout(() => setFlash(false), 180);
    navigator.vibrate?.(30);
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    shot.current({ canvas: c, quad: quadRef.current });
  };

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
          video: deviceId
            ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
            : { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
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

  async function setTorchOn(on: boolean) {
    const tr = (video.current?.srcObject as MediaStream | null)?.getVideoTracks()[0];
    try {
      await tr?.applyConstraints({ advanced: [{ torch: on } as Record<string, unknown>] });
      setTorch(on);
    } catch { /* torch unsupported on this camera */ }
  }

  // Detection loop: steadiness + sharpness from a tiny sample, corners from jscanify.
  useEffect(() => {
    if (!active) return;
    const sample = document.createElement('canvas');
    sample.width = SAMPLE_W; sample.height = SAMPLE_H;
    const sctx = sample.getContext('2d', { willReadFrequently: true })!;
    let prev: Uint8ClampedArray | null = null;
    let steady = 0;
    let cooldown = 0;
    let last: Quad | null = null;
    let running = true;
    const id = setInterval(() => {
      void (async () => {
        const v = video.current;
        if (!v || !v.videoWidth || document.hidden || !running) return;
        if (cooldown > 0) { cooldown--; return; }
        // Steadiness + sharpness on the cheap sample (same recipe as the classic camera).
        sctx.drawImage(v, 0, 0, v.videoWidth, v.videoHeight, 0, 0, SAMPLE_W, SAMPLE_H);
        let px: ImageData;
        try { px = sctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H); } catch { return; }
        const still = prev ? motion(prev, px.data) < MOTION_MAX : false;
        prev = px.data.slice();
        const sharp = sharpness(px.data, SAMPLE_W, SAMPLE_H);
        if (engineState() !== 'ready') { steady = 0; last = null; setQuad(null); setHint('engine'); return; }
        let found: Quad | null = null;
        try { found = await detectCard(v, v.videoWidth, v.videoHeight); } catch { found = null; }
        if (!running) return;
        if (!found) { steady = 0; last = null; setQuad(null); setHint(still ? 'find' : 'hold'); return; }
        setQuad(found);
        if (!still) { steady = 0; last = found; setHint('hold'); return; }
        if (sharp < SHARP_MIN) { steady = 0; last = found; setHint('blur'); return; }
        if (last && quadsClose(last, found, 0.02, v.videoWidth, v.videoHeight)) steady++;
        else steady = 1;
        last = found;
        setHint('ready');
        if (autoCapture && steady >= STEADY_FRAMES) {
          steady = 0; cooldown = 16; last = null;
          capture();
        }
      })();
    }, 500);
    return () => { running = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, autoCapture]);

  // Track the displayed box for the cover-fit overlay mapping.
  useEffect(() => {
    if (!active) return;
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setView({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [active]);

  if (error) {
    return (
      <div class="flex h-full min-h-64 flex-col items-center justify-center gap-3 bg-slate-900 p-6 text-center text-white">
        <CameraOff class="size-10 text-white/60" />
        <p class="max-w-xs text-sm text-white/90">{error}</p>
      </div>
    );
  }

  const v = video.current;
  const vw = v?.videoWidth ?? 0;
  const vh = v?.videoHeight ?? 0;
  // object-cover mapping: frame pixel → displayed pixel.
  const cover = vw && vh && view.w && view.h ? (() => {
    const s = Math.max(view.w / vw, view.h / vh);
    return { s, ox: (view.w - vw * s) / 2, oy: (view.h - vh * s) / 2 };
  })() : null;
  const pts = quad && cover
    ? [quad.tl, quad.tr, quad.br, quad.bl].map((p) => `${(p.x * cover.s + cover.ox).toFixed(1)},${(p.y * cover.s + cover.oy).toFixed(1)}`).join(' ')
    : null;

  const hintText = {
    engine: t('Loading the pro scanner… keep aiming'),
    find: t('Point at the card on a plain background'),
    hold: t('Hold steady…'),
    blur: t('Too blurry — move a little closer or add light'),
    ready: t('Card found — capturing…'),
  }[hint];

  return (
    <div ref={box} class="relative h-full min-h-64 overflow-hidden bg-slate-900">
      <video ref={video} class="absolute inset-0 size-full object-cover" playsInline muted autoPlay />
      {pts && (
        <svg class="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
          <polygon points={pts} fill="rgba(5,150,105,0.12)" stroke="#10b981" stroke-width="3" stroke-linejoin="round" />
          {[quad!.tl, quad!.tr, quad!.br, quad!.bl].map((p, i) => (
            <circle key={i} cx={p.x * cover!.s + cover!.ox} cy={p.y * cover!.s + cover!.oy} r="6" fill="#10b981" stroke="#fff" stroke-width="2" />
          ))}
        </svg>
      )}
      {engine === 'error' && (
        <p class="absolute inset-x-4 top-3 rounded-xl bg-red-600/90 px-3 py-2 text-center text-xs font-semibold text-white">
          {t('The pro engine needs internet once to load. You can keep aiming, or use the classic scanner.')}
        </p>
      )}
      <p class={`absolute inset-x-0 bottom-4 mx-auto w-fit max-w-[92%] rounded-full px-3 py-1 text-center text-xs font-semibold backdrop-blur ${hint === 'blur' ? 'bg-amber-400/90 text-amber-950' : hint === 'ready' ? 'bg-brand-500/90 text-white' : 'bg-black/50 text-white'}`}>{hintText}</p>
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
