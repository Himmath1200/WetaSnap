import { useEffect, useRef, useState } from 'preact/hooks';
import { Crop, Loader2, ScanSearch } from 'lucide-preact';
import { detectCard, extractCard, type Pt, type Quad } from '../lib/scanEngine';
import { applyFilter, developScan, type ScanFilter } from '../lib/scanV2';
import { reportError } from '../lib/errors';
import { t } from '../lib/i18n';

interface Props {
  /** Full-resolution snapshot to true up. */
  photo: HTMLCanvasElement;
  /** Corners from the live overlay (same pixel space), if the camera found them. */
  initial: Quad | null;
  onDone: (blob: Blob) => void;
  onRetake: () => void;
}

const FILTERS: Array<{ id: ScanFilter; label: string }> = [
  { id: 'color', label: 'Colour' },
  { id: 'gray', label: 'Grey' },
  { id: 'bw', label: 'B&W' },
];

const insetQuad = (w: number, h: number): Quad => {
  const mx = w * 0.08;
  const my = h * 0.08;
  return { tl: { x: mx, y: my }, tr: { x: w - mx, y: my }, br: { x: w - mx, y: h - my }, bl: { x: mx, y: h - my } };
};

const HANDLE_KEYS = ['tl', 'tr', 'br', 'bl'] as const;
const HANDLE_LABEL = { tl: 'Top-left corner', tr: 'Top-right corner', br: 'Bottom-right corner', bl: 'Bottom-left corner' } as const;

/**
 * SCAN-V2 · true-up step. Drag the four corners onto the card edges (CamScanner
 * style), pick a look, check the flat preview, then the scan goes to the same
 * review form as the classic scanner.
 */
export function CornerEditor({ photo, initial, onDone, onRetake }: Props) {
  const W = photo.width;
  const H = photo.height;
  const [url] = useState(() => photo.toDataURL('image/jpeg', 0.85));
  const [quad, setQuad] = useState<Quad>(initial ?? insetQuad(W, H));
  const [detecting, setDetecting] = useState(!initial);
  const [filter, setFilter] = useState<ScanFilter>('color');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const drag = useRef<{ key: (typeof HANDLE_KEYS)[number] } | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  /** Contain-fit size of the photo inside its box — the overlay shares this exact box, so it always lines up. */
  const [fit, setFit] = useState({ w: 0, h: 0 });
  const live = useRef({ quad, filter });
  live.current = { quad, filter };

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const s = Math.min(r.width / W, r.height / H);
      setFit({ w: Math.max(1, Math.floor(W * s)), h: Math.max(1, Math.floor(H * s)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // No live corners (upload, or the camera never locked on): detect once. A model
  // that cannot load is not fatal — the inset quad is still draggable and warps.
  useEffect(() => {
    if (initial) return;
    let stop = false;
    (async () => {
      try {
        const found = await detectCard(photo, W, H);
        if (!stop && found) setQuad(found);
      } catch { /* manual corners stand */ } finally {
        if (!stop) setDetecting(false);
      }
    })();
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Flat preview, refreshed as corners / the look change (debounced).
  // It runs the same warp + filter as the final scan, so it never lies.
  useEffect(() => {
    let stop = false;
    const id = setTimeout(() => {
      void (async () => {
        const { quad: q, filter: f } = live.current;
        try {
          const warped = await extractCard(photo, W, H, q);
          if (stop || !warped) { setPreview(null); return; }
          applyFilter(warped.canvas, f);
          const small = document.createElement('canvas');
          const k = Math.min(1, 480 / Math.max(warped.canvas.width, warped.canvas.height));
          small.width = Math.max(2, Math.round(warped.canvas.width * k));
          small.height = Math.max(2, Math.round(warped.canvas.height * k));
          small.getContext('2d')!.drawImage(warped.canvas, 0, 0, small.width, small.height);
          if (!stop) setPreview(small.toDataURL('image/jpeg', 0.8));
        } catch {
          if (!stop) setPreview(null);
        }
      })();
    }, 350);
    return () => { stop = true; clearTimeout(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quad, filter]);

  const toPhoto = (clientX: number, clientY: number): Pt => {
    const r = frame.current!.getBoundingClientRect();
    return {
      x: Math.min(W, Math.max(0, ((clientX - r.left) / r.width) * W)),
      y: Math.min(H, Math.max(0, ((clientY - r.top) / r.height) * H)),
    };
  };

  const onHandleMove = (e: { clientX: number; clientY: number; preventDefault(): void }, key: (typeof HANDLE_KEYS)[number]) => {
    if (drag.current?.key !== key) return;
    e.preventDefault();
    const p = toPhoto(e.clientX, e.clientY);
    setQuad((q) => ({ ...q, [key]: p }));
  };

  async function useScan() {
    setBusy(true);
    try {
      const warped = await extractCard(photo, W, H, quad);
      if (!warped) throw new Error('no warp');
      onDone(await developScan(warped.canvas, filter));
    } catch (e) {
      reportError(e, { action: 'Use the pro scan', where: 'ScanV2 › CornerEditor' });
    } finally {
      setBusy(false);
    }
  }


  // viewBox user units (0–100): percentages are not valid in polygon points.
  const poly = [quad.tl, quad.tr, quad.br, quad.bl]
    .map((p) => `${((p.x / W) * 100).toFixed(2)},${((p.y / H) * 100).toFixed(2)}`)
    .join(' ');

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <Crop class="size-4 text-brand-700" />
        <p class="text-sm font-bold">{t('Line up the corners')}</p>
        <span class="ml-auto text-xs text-muted">{t('Drag each dot onto the card edge')}</span>
      </div>

      <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 lg:flex-row">
        <div ref={wrap} class="flex min-h-72 flex-1 items-center justify-center overflow-hidden rounded-2xl bg-black p-2 lg:min-h-96">
          <div
            ref={frame}
            class="relative touch-none overflow-hidden rounded-lg select-none"
            style={fit.w ? { width: fit.w, height: fit.h } : { width: '100%', aspectRatio: `${W} / ${H}` }}
          >
          <img src={url} alt={t('Card photo')} class="absolute inset-0 size-full" draggable={false} />
          <svg class="pointer-events-none absolute inset-0 size-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <polygon points={poly} fill="rgba(5,150,105,0.15)" stroke="#10b981" stroke-width="1" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
          </svg>
          {HANDLE_KEYS.map((k) => (
            <button
              key={k}
              class="absolute z-10 flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full"
              style={{ left: `${(quad[k].x / W) * 100}%`, top: `${(quad[k].y / H) * 100}%` }}
              aria-label={t(HANDLE_LABEL[k])}
              onPointerDown={(e) => { drag.current = { key: k }; e.currentTarget.setPointerCapture(e.pointerId); }}
              onPointerMove={(e) => onHandleMove(e, k)}
              onPointerUp={() => { drag.current = null; }}
              onPointerCancel={() => { drag.current = null; }}
            >
              <span class="size-5 rounded-full border-[3px] border-white bg-brand-600 shadow-lg" />
            </button>
          ))}
          {detecting && (
            <div class="absolute inset-0 flex items-center justify-center bg-slate-900/60">
              <p class="flex items-center gap-2 rounded-full bg-black/60 px-4 py-2 text-sm font-semibold text-white">
                <Loader2 class="size-4 animate-spin" />{t('Finding the card…')}
              </p>
            </div>
          )}
          </div>
        </div>

        <div class="flex flex-col gap-3 lg:w-64">
          <div>
            <p class="label">{t('Look')}</p>
            <div class="grid grid-cols-3 gap-1 rounded-xl border border-line bg-subtle p-1" role="radiogroup" aria-label={t('Look')}>
              {FILTERS.map((f) => (
                <button
                  key={f.id} role="radio" aria-checked={filter === f.id}
                  onClick={() => setFilter(f.id)}
                  class={`min-h-11 rounded-lg text-sm font-semibold ${filter === f.id ? 'on-brand' : 'text-slate-600'}`}
                >
                  {t(f.label)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p class="label">{t('Flat preview')}</p>
            <div class="flex min-h-28 items-center justify-center overflow-hidden rounded-xl border border-line bg-subtle">
              {preview
                ? <img src={preview} alt={t('Flat preview')} class="max-h-48 w-full object-contain" />
                : <p class="flex items-center gap-2 px-3 py-6 text-xs text-muted"><ScanSearch class="size-4" />{detecting ? t('Finding the card…') : t('Move the corners onto the card')}</p>}
            </div>
          </div>
          <button
            class="btn-secondary min-h-11 w-full"
            disabled={detecting}
            onClick={async () => {
              setDetecting(true);
              try {
                const found = await detectCard(photo, W, H);
                if (found) setQuad(found);
              } catch (e) {
                reportError(e, { action: 'Auto-detect the card corners', where: 'ScanV2 › CornerEditor' });
              } finally {
                setDetecting(false);
              }
            }}
          >
            <ScanSearch class="size-4" />{t('Auto-detect')}
          </button>
        </div>
      </div>

      <div class="flex items-center gap-3 border-t border-line bg-surface px-4 py-3 pb-[env(safe-area-inset-bottom)]">
        <button class="link tap text-sm" onClick={onRetake}>{t('Retake')}</button>
        <button class="btn-primary ml-auto min-w-40" disabled={busy || detecting} onClick={() => void useScan()}>
          {busy ? <Loader2 class="size-5 animate-spin" /> : t('Use scan')}
        </button>
      </div>
    </div>
  );
}
