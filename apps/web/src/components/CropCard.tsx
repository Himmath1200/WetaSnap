import { useEffect, useRef, useState } from 'preact/hooks';
import { Check, Eye, PenLine, RotateCw, X } from 'lucide-preact';
import { rectToQuad, rotFwd, rotInvDelta, scanBlob, scanPreview, type Pt, type Quad, type ScanFilter } from '../lib/scan';
import { t } from '../lib/i18n';
import { Spinner } from './ui';

/**
 * Scan / adjust — the step between taking the photo and reading it (SCAN-02).
 *
 * CamScanner-style: drag the card's four corners so a tilted photo is pulled straight,
 * pick a look (Enhance / Colour / Grey / Mono), rotate, then "Use scan". The photo leaves
 * here as a flat, evenly-lit scan — that is also what the reader sees, so small print reads better.
 * Everything happens on the device.
 */

type Corner = 'tl' | 'tr' | 'br' | 'bl' | 'move';

const FILTERS: Array<{ id: ScanFilter; label: string }> = [
  { id: 'enhance', label: 'Enhance' },
  { id: 'color', label: 'Colour' },
  { id: 'gray', label: 'Grey' },
  { id: 'bw', label: 'Mono' },
];

export function CropCard({ photo, onCancel, onDone }: {
  photo: Blob;
  onCancel: () => void;
  onDone: (scanned: Blob) => void;
}) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [quad, setQuad] = useState<Quad | null>(null);
  const [rotation, setRotation] = useState(0);
  const [filter, setFilter] = useState<ScanFilter>('enhance');
  const [tab, setTab] = useState<'adjust' | 'preview'>('adjust');
  // Display bitmap: the photo physically turned (no CSS rotate, so corners always line up).
  const [dispUrl, setDispUrl] = useState<string | null>(null);
  const [disp, setDisp] = useState<{ w: number; h: number } | null>(null);
  const [scanUrl, setScanUrl] = useState<string | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ corner: Corner; startX: number; startY: number; from: Quad } | null>(null);
  const scanToken = useRef(0);

  useEffect(() => {
    let dead = false;
    let url: string | null = null;
    (async () => {
      const bmp = await createImageBitmap(photo);
      if (dead) { bmp.close(); return; }
      setSize({ w: bmp.width, h: bmp.height });
      setQuad(rectToQuad(bmp.width, bmp.height, Math.round(Math.min(bmp.width, bmp.height) * 0.04)));
      bmp.close();
    })().catch(() => {});
    return () => { dead = true; if (url) URL.revokeObjectURL(url); };
  }, [photo]);

  // Re-render the display bitmap when the photo turns (downscaled — dragging needs pixels, not megapixels).
  useEffect(() => {
    if (!size) return;
    let dead = false;
    let url: string | null = null;
    (async () => {
      const bmp = await createImageBitmap(photo);
      if (dead) { bmp.close(); return; }
      const turned = rotation % 180 !== 0;
      const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round((turned ? bmp.height : bmp.width) * k));
      c.height = Math.max(1, Math.round((turned ? bmp.width : bmp.height) * k));
      const ctx = c.getContext('2d')!;
      ctx.translate(c.width / 2, c.height / 2);
      if (rotation) ctx.rotate((rotation * Math.PI) / 180);
      ctx.drawImage(bmp, (-bmp.width * k) / 2, (-bmp.height * k) / 2, bmp.width * k, bmp.height * k);
      bmp.close();
      const blob = await new Promise<Blob | null>((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.85));
      if (dead) return;
      if (blob) {
        url = URL.createObjectURL(blob);
        setDispUrl((old) => { if (old) URL.revokeObjectURL(old); return url; });
        setDisp({ w: c.width, h: c.height });
      }
    })().catch(() => {});
    return () => { dead = true; if (url) URL.revokeObjectURL(url); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo, size, rotation]);

  // Live clean-scan preview, debounced — same pipeline as the final scan, capped at 640 px.
  useEffect(() => {
    if (!quad || !size) return;
    const token = ++scanToken.current;
    setScanBusy(true);
    const h = setTimeout(() => {
      scanPreview(photo, quad, rotation, filter)
        .then((b) => {
          if (token !== scanToken.current) return;
          setScanUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(b); });
        })
        .catch(() => {})
        .finally(() => { if (token === scanToken.current) setScanBusy(false); });
    }, 350);
    return () => clearTimeout(h);
  }, [photo, quad, rotation, filter, size]);

  useEffect(() => () => { if (scanUrl) URL.revokeObjectURL(scanUrl); }, [scanUrl]);
  useEffect(() => () => { if (dispUrl) URL.revokeObjectURL(dispUrl); }, [dispUrl]);

  /** Screen pixels → turned-display pixels → original-photo pixels, via the live drag start. */
  function toPhoto(e: { clientX: number; clientY: number }): { dx: number; dy: number } {
    const box = frame.current?.getBoundingClientRect();
    if (!box || !disp || !size || !box.width || !box.height) return { dx: 0, dy: 0 };
    const turned = rotation % 180 !== 0;
    const fullW = turned ? size.h : size.w;
    const fullH = turned ? size.w : size.h;
    const start = drag.current;
    if (!start) return { dx: 0, dy: 0 };
    const dx = ((e.clientX - start.startX) / box.width) * disp.w;
    const dy = ((e.clientY - start.startY) / box.height) * disp.h;
    const back = rotInvDelta({ x: dx * (fullW / disp.w), y: dy * (fullH / disp.h) }, rotation);
    return { dx: back.x, dy: back.y };
  }

  function onPointerDown(e: PointerEvent, corner: Corner) {
    if (!quad) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { corner, startX: e.clientX, startY: e.clientY, from: { ...quad, tl: { ...quad.tl }, tr: { ...quad.tr }, br: { ...quad.br }, bl: { ...quad.bl } } };
  }

  function onPointerMove(e: PointerEvent) {
    const state = drag.current;
    if (!state || !size) return;
    const { dx, dy } = toPhoto(e);
    const min = Math.min(size.w, size.h) * 0.05;
    const q: Quad = {
      tl: { ...state.from.tl }, tr: { ...state.from.tr },
      br: { ...state.from.br }, bl: { ...state.from.bl },
    };
    const move = (p: Pt) => ({ x: clamp(p.x + dx, 0, size.w), y: clamp(p.y + dy, 0, size.h) });
    if (state.corner === 'move') {
      // Shift the whole quad, clamped so no corner leaves the photo.
      const xs = [q.tl.x, q.tr.x, q.br.x, q.bl.x];
      const ys = [q.tl.y, q.tr.y, q.br.y, q.bl.y];
      const cx = clamp(dx, -Math.min(...xs), size.w - Math.max(...xs));
      const cy = clamp(dy, -Math.min(...ys), size.h - Math.max(...ys));
      for (const p of [q.tl, q.tr, q.br, q.bl]) { p.x += cx; p.y += cy; }
    } else {
      q[state.corner] = move(state.from[state.corner]);
      // Keep a minimum size so the quad cannot collapse inside-out.
      const w = Math.min(q.tr.x - q.tl.x, q.br.x - q.bl.x);
      const h = Math.min(q.bl.y - q.tl.y, q.br.y - q.tr.y);
      if (w < min || h < min) return;
    }
    setQuad(q);
  }

  const onPointerUp = () => { drag.current = null; };

  async function use() {
    if (!quad) return;
    setBusy(true);
    try {
      onDone(await scanBlob(photo, quad, rotation, filter));
    } finally {
      setBusy(false);
    }
  }

  const turned = rotation % 180 !== 0;
  const fullW = size ? (turned ? size.h : size.w) : 0;
  const fullH = size ? (turned ? size.w : size.h) : 0;
  // Quad in original-photo pixels → turned-display percent (numbers for SVG, strings for HTML).
  const num = (p: Pt) => {
    if (!size || !fullW || !fullH) return { x: 0, y: 0 };
    const f = rotFwd(p, size.w, size.h, rotation);
    return { x: (f.x / fullW) * 100, y: (f.y / fullH) * 100 };
  };
  const pct = (p: Pt) => {
    const n = num(p);
    return { left: `${n.x}%`, top: `${n.y}%` };
  };
  const quadNums = quad ? (['tl', 'tr', 'br', 'bl'] as const).map((k) => num(quad[k])) : [];
  const quadInner = quadNums.map((p) => `M${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' L') + (quadNums.length ? ' Z' : '');
  const quadPoly = quadNums.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');

  return (
    <div class="fixed inset-0 z-50 flex flex-col bg-slate-950">
      <div class="flex items-center justify-between px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
        <button class="flex min-h-11 items-center gap-1.5 text-sm font-semibold text-white/80 hover:text-white" onClick={onCancel}>
          <X class="size-5" />{t('Retake')}
        </button>
        <span class="text-sm font-semibold text-white/90">{t('Scan / adjust')}</span>
        <button class="flex size-11 items-center justify-center rounded-full text-white/80 hover:bg-white/10 hover:text-white"
          onClick={() => setRotation((r) => (r + 90) % 360)} aria-label={t('Rotate')}>
          <RotateCw class="size-5" />
        </button>
      </div>

      {/* Adjust ↔ clean-scan preview */}
      <div class="flex justify-center gap-1 px-4 pb-2">
        {([['adjust', t('Adjust'), PenLine], ['preview', t('Scan'), Eye]] as const).map(([id, label, Icon]) => (
          <button key={id} onClick={() => setTab(id)}
            class={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl text-sm font-semibold ${tab === id ? 'bg-white text-slate-900' : 'text-white/70 hover:text-white'}`}>
            <Icon class="size-4" />{label}
          </button>
        ))}
      </div>

      <div class="relative flex min-h-0 flex-1 items-center justify-center px-3">
        {tab === 'adjust' ? (
          <div ref={frame} class="relative max-h-full" onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
            {dispUrl && (
              <img src={dispUrl} alt="" class="max-h-[52dvh] w-auto rounded-xl select-none" draggable={false} />
            )}
            {quad && size && (
              <>
                {/* Dimmed outside + white quad edge. The mask dims only the photo, via a path with
                    two subpaths (outer frame, inner quad) under the evenodd rule — no giant fill. */}
                <svg class="pointer-events-none absolute inset-0 size-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                  <path d={`M0,0 L100,0 L100,100 L0,100 Z ${quadInner}`} fill="rgba(2,6,23,0.55)" fill-rule="evenodd" />
                  <polygon points={quadPoly} fill="none" stroke="white" stroke-width="0.7" vector-effect="non-scaling-stroke" />
                </svg>
                <div class="absolute inset-0 cursor-move touch-none"
                  onPointerDown={(e) => onPointerDown(e as unknown as PointerEvent, 'move')}>
                  {(['tl', 'tr', 'br', 'bl'] as const).map((corner) => {
                    const p = pct(quad[corner]);
                    return (
                      <button key={corner} type="button" aria-label={t('Adjust corner')}
                        class="absolute size-11 touch-none" style={{ left: p.left, top: p.top, transform: 'translate(-50%,-50%)' }}
                        onPointerDown={(e) => onPointerDown(e as unknown as PointerEvent, corner)}>
                        <span class="absolute top-1/2 left-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-brand-500 bg-white" />
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        ) : (
          <div class="relative flex max-h-full items-center justify-center">
            {scanUrl
              ? <img src={scanUrl} alt={t('Scanned preview')} class="max-h-[52dvh] w-auto rounded-xl bg-white" />
              : <div class="flex h-40 w-64 items-center justify-center rounded-xl bg-white/10"><Spinner /></div>}
            {scanBusy && <span class="absolute bottom-2 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-semibold text-white">{t('Updating…')}</span>}
          </div>
        )}
      </div>

      {/* CamScanner-style looks */}
      <div class="flex justify-center gap-2 px-4 pt-2">
        {FILTERS.map((f) => (
          <button key={f.id} onClick={() => setFilter(f.id)}
            class={`min-h-11 flex-1 rounded-xl text-xs font-bold ${filter === f.id ? 'bg-brand-600 text-white' : 'bg-white/10 text-white/80 hover:bg-white/20'}`}>
            {t(f.label)}
          </button>
        ))}
      </div>

      <div class="px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <p class="mb-3 text-center text-xs text-white/60">
          {tab === 'adjust'
            ? t('Drag the corners onto the card edges — the scan is straightened to them.')
            : t('This is the clean scan that will be saved and read.')}
        </p>
        <button class="btn-primary w-full" disabled={busy || !quad} onClick={() => void use()}>
          {busy ? <Spinner /> : <><Check class="size-5" />{t('Use scan')}</>}
        </button>
      </div>
    </div>
  );
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
