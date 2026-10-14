import { describe, expect, it } from 'vitest';
import { autoLevels, boundsOfMask, enhanceCurve, flattenWeight, inkBlack, paperWhite, sauvolaBinarize } from '../scan';

/** SCAN-02: the auto colour clean-up levels must hold exactly — these run in Node, no canvas. */
describe('clean-scan levels', () => {
  it('Sauvola splits a page into ink and paper', () => {
    const w = 60;
    const h = 40;
    const g = new Float32Array(w * h).fill(235);
    for (let y = 14; y < 26; y++) for (let x = 8; x < 52; x++) g[y * w + x] = 30; // a dark band
    const bw = sauvolaBinarize(g, w, h);
    expect(bw[20 * w + 30]).toBe(0);
    expect(bw[2 * w + 2]).toBe(255);
  });

  it('Sauvola holds dark print under a shadow gradient', () => {
    const w = 60;
    const h = 40;
    const g = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = 235 - y * 3; // darker at the bottom
    for (let x = 8; x < 52; x++) g[34 * w + x] = 235 - 34 * 3 - 110; // print in the shadow
    const bw = sauvolaBinarize(g, w, h);
    expect(bw[34 * w + 30]).toBe(0);
    expect(bw[2 * w + 2]).toBe(255);
  });

  it('auto-levels ignore specks and survive flat images', () => {
    const samples = [...Array(98).fill(200), 5, 250]; // 1% specks each end
    const [lo, hi] = autoLevels(samples);
    expect(lo).toBeGreaterThanOrEqual(190);
    expect(hi).toBeLessThanOrEqual(210);
    expect(autoLevels([])).toEqual([0, 255]);
  });

  it('flatten leaves real print alone — including faint grey small print', () => {
    expect(flattenWeight(30, 230)).toBe(0); // black headline: no boost
    expect(flattenWeight(150, 230)).toBe(0); // faint grey email at 65% of bg: no boost
    expect(flattenWeight(200, 230)).toBeGreaterThan(0.3); // light shadow: partial
    expect(flattenWeight(228, 230)).toBe(1); // paper: full correction
  });

  it('enhance curve passes print through untouched, snaps only paper white', () => {
    const black = 25;
    const white = 225;
    expect(enhanceCurve(225, black, white)).toBe(255);
    expect(enhanceCurve(245, black, white)).toBe(255);
    expect(enhanceCurve(223, black, white)).toBe(255); // paper tolerance: ±2 sensor noise
    expect(enhanceCurve(165, black, white)).toBe(165); // faint grey: byte-identical
    expect(enhanceCurve(115, black, white)).toBe(115); // coloured print: byte-identical
    expect(enhanceCurve(25, black, white)).toBe(31); // crushed blacks open a whisper
    expect(enhanceCurve(10, black, white)).toBe(31);
  });

  it('white point lands on paper even with faint text on the page', () => {
    const page = [...Array(70).fill(232), ...Array(25).fill(165), ...Array(5).fill(25)];
    const white = paperWhite(page);
    expect(white).toBeGreaterThanOrEqual(220);
    expect(white).toBeLessThanOrEqual(240);
    const black = inkBlack(page);
    expect(black).toBeLessThanOrEqual(40);
    expect(black).toBeGreaterThanOrEqual(0);
    expect(inkBlack([])).toBe(25);
  });
});

/** SCAN-02 auto-crop: find the card rect from a mask, padded, or decline to cut. */
describe('card bounds from a mask', () => {
  /** A card rectangle inside a table: foreground 1 inside, 0 outside. */
  const card = (w: number, h: number, x0: number, y0: number, x1: number, y1: number, specks = 0) => {
    const fg = new Uint8Array(w * h);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) fg[y * w + x] = 1;
    for (let i = 0; i < specks; i++) fg[(i * 7919) % (w * h)] = 1; // deterministic table specks
    return fg;
  };

  it('finds a centred card and pads it so no side is lost', () => {
    const r = boundsOfMask(card(100, 60, 10, 8, 89, 51), 100, 60)!;
    expect(r).not.toBeNull();
    expect(r.x).toBeLessThanOrEqual(10); // pad reaches past the true edge…
    expect(r.y).toBeLessThanOrEqual(8);
    expect(r.x + r.w).toBeGreaterThanOrEqual(90); // …on every side
    expect(r.y + r.h).toBeGreaterThanOrEqual(52);
  });

  it('ignores specks on the table', () => {
    const r = boundsOfMask(card(100, 60, 12, 10, 87, 49, 40), 100, 60)!;
    expect(r.x).toBeLessThanOrEqual(12);
    expect(r.x + r.w).toBeGreaterThanOrEqual(88);
  });

  it('declines an empty frame, a full-bleed card, and a tiny false positive', () => {
    expect(boundsOfMask(new Uint8Array(100 * 60), 100, 60)).toBeNull();
    expect(boundsOfMask(new Uint8Array(100 * 60).fill(1), 100, 60)).toBeNull();
    expect(boundsOfMask(card(100, 60, 45, 25, 55, 35), 100, 60)).toBeNull();
  });
});
