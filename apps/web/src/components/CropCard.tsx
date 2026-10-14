import { useEffect, useRef, useState } from 'preact/hooks';
import { Check, Crop, RotateCw, X } from 'lucide-preact';
import { compressCard } from '../lib/image';
import { t } from '../lib/i18n';
import { Spinner } from './ui';

/**
 * Crop / adjust — the step between taking the photo and reading it (SCAN-02).
 *
 * The camera already frames the card and only fires when one is in front of it, so this opens
 * with the card's own edges selected and most people just tap "Use photo". Dragging the corners
 * is there for the awkward ones: a card on a patterned tablecloth, two cards at once, a stand
 * banner behind it. Cropping before reading matters — the reader gets three times the pixels per
 * letter once the table, the lanyard and the hand are gone.
 *
 * Everything happens on the device: the picture never leaves it to be cropped.
 */
export interface CropRect { x: number; y: number; w: number; h: number }

type Corner = 'nw' | 'ne' | 'sw' | 'se' | 'move';

export function CropCard({ photo, onCancel, onDone }: {
  photo: Blob;
  onCancel: () => void;
  onDone: (cropped: Blob) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [rect, setRect] = useState<CropRect | null>(null);
  const [rotation, setRotation] = useState(0);
  const [busy, setBusy] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ corner: Corner; startX: number; startY: number; from: CropRect } | null>(null);

  useEffect(() => {
    const objectUrl = URL.createObjectURL(photo);
    setUrl(objectUrl);
    const image = new Image();
    image.onload = () => {
      setSize({ w: image.naturalWidth, h: image.naturalHeight });
      // Open on the whole photo. The camera has already framed the card, and an uploaded file
      // may be anything — cutting into it by default would shave the first letter off a line.
      setRect({ x: 0, y: 0, w: image.naturalWidth, h: image.naturalHeight });
    };
    image.src = objectUrl;
    return () => URL.revokeObjectURL(objectUrl);
  }, [photo]);

  /** Screen pixels → image pixels, so a drag means the same at any screen size. */
  function scale(): number {
    const box = frame.current?.getBoundingClientRect();
    if (!box || !size) return 1;
    return size.w / box.width;
  }

  function onPointerDown(e: PointerEvent, corner: Corner) {
    if (!rect) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { corner, startX: e.clientX, startY: e.clientY, from: { ...rect } };
  }

  function onPointerMove(e: PointerEvent) {
    const state = drag.current;
    if (!state || !size || !rect) return;
    const k = scale();
    const dx = (e.clientX - state.startX) * k;
    const dy = (e.clientY - state.startY) * k;
    const min = Math.min(size.w, size.h) * 0.15;
    let { x, y, w, h } = state.from;

    if (state.corner === 'move') {
      x = clamp(x + dx, 0, size.w - w);
      y = clamp(y + dy, 0, size.h - h);
    } else {
      if (state.corner.includes('w')) { const nx = clamp(x + dx, 0, x + w - min); w += x - nx; x = nx; }
      if (state.corner.includes('e')) { w = clamp(w + dx, min, size.w - x); }
      if (state.corner.includes('n')) { const ny = clamp(y + dy, 0, y + h - min); h += y - ny; y = ny; }
      if (state.corner.includes('s')) { h = clamp(h + dy, min, size.h - y); }
    }
    setRect({ x, y, w, h });
  }

  const onPointerUp = () => { drag.current = null; };

  async function use() {
    if (!rect || !size) return;
    setBusy(true);
    try {
      onDone(await crop(photo, rect, rotation));
    } finally {
      setBusy(false);
    }
  }

  const percent = (value: number, total: number) => `${(value / total) * 100}%`;

  return (
    <div class="fixed inset-0 z-50 flex flex-col bg-slate-950">
      <div class="flex items-center justify-between px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
        <button class="flex min-h-11 items-center gap-1.5 text-sm font-semibold text-white/80 hover:text-white" onClick={onCancel}>
          <X class="size-5" />{t('Retake')}
        </button>
        <span class="flex items-center gap-1.5 text-sm font-semibold text-white/90">
          <Crop class="size-4" />{t('Crop / adjust')}
        </span>
        <button class="flex size-11 items-center justify-center rounded-full text-white/80 hover:bg-white/10 hover:text-white"
          onClick={() => setRotation((r) => (r + 90) % 360)} aria-label={t('Rotate')}>
          <RotateCw class="size-5" />
        </button>
      </div>

      <div class="relative flex min-h-0 flex-1 items-center justify-center px-3">
        <div ref={frame} class="relative max-h-full" onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          {url && (
            <img src={url} alt="" class="max-h-[60dvh] w-auto rounded-xl select-none"
              style={{ transform: `rotate(${rotation}deg)` }} draggable={false} />
          )}
          {rect && size && (
            <>
              {/* everything outside the selection, dimmed */}
              <div class="pointer-events-none absolute inset-0 rounded-xl"
                style={{
                  background: 'rgba(2,6,23,0.55)',
                  clipPath: `polygon(0% 0%, 0% 100%, ${percent(rect.x, size.w)} 100%, ${percent(rect.x, size.w)} ${percent(rect.y, size.h)}, ${percent(rect.x + rect.w, size.w)} ${percent(rect.y, size.h)}, ${percent(rect.x + rect.w, size.w)} ${percent(rect.y + rect.h, size.h)}, ${percent(rect.x, size.w)} ${percent(rect.y + rect.h, size.h)}, ${percent(rect.x, size.w)} 100%, 100% 100%, 100% 0%)`,
                }} />
              <div class="absolute cursor-move rounded-md border-2 border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0)] touch-none"
                style={{ left: percent(rect.x, size.w), top: percent(rect.y, size.h), width: percent(rect.w, size.w), height: percent(rect.h, size.h) }}
                onPointerDown={(e) => onPointerDown(e as unknown as PointerEvent, 'move')}>
                {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                  <button key={corner} type="button" aria-label={t('Adjust corner')}
                    class={`absolute size-11 touch-none rounded-full ${corner.includes('n') ? '-top-5' : '-bottom-5'} ${corner.includes('w') ? '-left-5' : '-right-5'}`}
                    onPointerDown={(e) => onPointerDown(e as unknown as PointerEvent, corner)}>
                    <span class="absolute top-1/2 left-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-brand-500 bg-white" />
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div class="px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <p class="mb-3 text-center text-xs text-white/60">{t('Drag the corners so only the card is inside the frame.')}</p>
        <button class="btn-primary w-full" disabled={busy || !rect} onClick={() => void use()}>
          {busy ? <Spinner /> : <><Check class="size-5" />{t('Use photo')}</>}
        </button>
      </div>
    </div>
  );
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Cuts the chosen rectangle out at full resolution, then compresses it like any other card. */
async function crop(photo: Blob, rect: CropRect, rotation: number): Promise<Blob> {
  const bitmap = await createImageBitmap(photo);
  const turned = rotation % 180 !== 0;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(turned ? rect.h : rect.w);
  canvas.height = Math.round(turned ? rect.w : rect.h);
  const ctx = canvas.getContext('2d')!;
  ctx.translate(canvas.width / 2, canvas.height / 2);
  if (rotation) ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(bitmap, rect.x, rect.y, rect.w, rect.h, -rect.w / 2, -rect.h / 2, rect.w, rect.h);
  bitmap.close();
  return compressCard(canvas);
}
