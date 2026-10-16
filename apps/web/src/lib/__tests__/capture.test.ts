import { describe, expect, it } from 'vitest';
import { isGlare, pickSharpest } from '../image';
import { mergeReads } from '../offlineReader';

const W = 160;
const H = 100;

function frame(paint: (set: (x: number, y: number, v: number) => void) => void): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4);
  const set = (x: number, y: number, v: number) => {
    const i = (y * W + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  };
  paint(set);
  return data;
}

/** Flat Laplacian helper: sharp frame has an edge, blurry one is flat. */
function sharpVsFlat() {
  const sharp = frame((set) => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, x < W / 2 ? 30 : 235);
  });
  const flat = frame((set) => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, 200 + ((x + y) % 3));
  });
  return { sharp, flat };
}

describe('burst capture', () => {
  it('picks the sharpest frame', () => {
    const { sharp, flat } = sharpVsFlat();
    expect(pickSharpest([
      { data: flat, w: W, h: H },
      { data: sharp, w: W, h: H },
      { data: flat, w: W, h: H },
    ])).toBe(1);
  });
});

describe('glare guard', () => {
  it('flags blown-out white with no print', () => {
    const glare = frame((set) => {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, 252);
    });
    expect(isGlare(glare, W, H)).toBe(true);
  });

  it('does not flag a normal card with print', () => {
    const card = frame((set) => {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, 235);
      for (let x = 20; x < 120; x++) { set(x, 40, 30); set(x, 60, 30); }
    });
    expect(isGlare(card, W, H)).toBe(false);
  });
});

describe('multi-pass vote', () => {
  it('keeps the higher-confidence value per field', () => {
    const out = mergeReads([
      { email: { value: 'a@x.de', confidence: 0.9, by: 'offline' }, phone: { value: '+49 1', confidence: 0.5, by: 'offline' } },
      { phone: { value: '+49 151 23456789', confidence: 0.8, by: 'offline' } },
    ]);
    expect(out.email?.value).toBe('a@x.de');
    expect(out.phone?.value).toBe('+49 151 23456789');
  });

  it('skips empty values', () => {
    const out = mergeReads([{ email: { value: '', confidence: 0.9, by: 'offline' } }]);
    expect(out.email).toBeUndefined();
  });
});
