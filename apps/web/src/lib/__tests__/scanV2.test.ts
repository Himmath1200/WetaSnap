import { describe, expect, it } from 'vitest';
import {
  orderQuadPoints, outputSizeFor, quadArea, quadAspect, quadIsSane, quadsClose, scaleQuad,
  warpPixels, type Quad,
} from '../scanEngine';

/** SCAN-V2: corner geometry + warp — these run in Node, no model, no canvas. */
const card = (w = 320, h = 200): Quad => ({
  tl: { x: 10, y: 10 }, tr: { x: w - 10, y: 12 }, br: { x: w - 12, y: h - 10 }, bl: { x: 12, y: h - 12 },
});

describe('pro scanner geometry', () => {
  it('measures the card footprint', () => {
    const a = quadArea({ tl: { x: 0, y: 0 }, tr: { x: 100, y: 0 }, br: { x: 100, y: 50 }, bl: { x: 0, y: 50 } });
    expect(a).toBe(5000);
  });

  it('accepts a plausible card and rejects junk', () => {
    expect(quadIsSane(card(), 320, 200)).toBe(true);
    // A speck of an edge.
    expect(quadIsSane({ tl: { x: 10, y: 10 }, tr: { x: 14, y: 10 }, br: { x: 14, y: 14 }, bl: { x: 10, y: 14 } }, 320, 200)).toBe(false);
    // The whole frame (no card edge visible).
    expect(quadIsSane({ tl: { x: 0, y: 0 }, tr: { x: 320, y: 0 }, br: { x: 320, y: 200 }, bl: { x: 0, y: 200 } }, 320, 200)).toBe(false);
    // Bow-tie (self-intersecting) is never a card.
    expect(quadIsSane({ tl: { x: 10, y: 10 }, tr: { x: 300, y: 190 }, br: { x: 310, y: 10 }, bl: { x: 10, y: 190 } }, 320, 200)).toBe(false);
    // NaN from a failed detection.
    const nan = card();
    nan.tr.x = NaN;
    expect(quadIsSane(nan, 320, 200)).toBe(false);
  });

  it('spots a steady hand', () => {
    const a = card();
    const b = card();
    b.tr.x += 2; b.br.y -= 2; // a couple of pixels of wobble
    expect(quadsClose(a, b, 0.02, 320, 200)).toBe(true);
    const c = card();
    c.br.x -= 60; // the outline jumped
    expect(quadsClose(a, c, 0.02, 320, 200)).toBe(false);
  });

  it('scales corners between thumbnail and full frame', () => {
    const q = scaleQuad({ tl: { x: 1, y: 1 }, tr: { x: 3, y: 1 }, br: { x: 3, y: 2 }, bl: { x: 1, y: 2 } }, 100, 100);
    expect(q.br).toEqual({ x: 300, y: 200 });
  });

  it('sizes the warp to the card proportions at 1600 px', () => {
    const { w, h } = outputSizeFor({ tl: { x: 0, y: 0 }, tr: { x: 856, y: 0 }, br: { x: 856, y: 540 }, bl: { x: 0, y: 540 } });
    expect(w).toBe(1600);
    expect(h).toBe(1009); // ID-1 ratio, not a square
  });

  it('orders shuffled model corners', () => {
    const onCard: Quad = { tl: { x: 20, y: 30 }, tr: { x: 80, y: 30 }, br: { x: 80, y: 70 }, bl: { x: 20, y: 70 } };
    expect(orderQuadPoints([{ x: 80, y: 70 }, { x: 20, y: 70 }, { x: 80, y: 30 }, { x: 20, y: 30 }])).toEqual(onCard);
  });

  it('measures proportions orientation-free', () => {
    expect(quadAspect({ tl: { x: 0, y: 0 }, tr: { x: 856, y: 0 }, br: { x: 856, y: 540 }, bl: { x: 0, y: 540 } })).toBeCloseTo(1.585, 2);
    expect(quadAspect({ tl: { x: 20, y: 30 }, tr: { x: 80, y: 30 }, br: { x: 80, y: 70 }, bl: { x: 20, y: 70 } })).toBeCloseTo(1.5, 2);
  });
});

describe('pro scanner warp', () => {
  /** Flat RGBA buffer whose red channel encodes x (clamped at 255). */
  const ramp = (w: number, h: number) => {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        px[i] = x; px[i + 1] = 100; px[i + 2] = 200; px[i + 3] = 255;
      }
    }
    return px;
  };

  it('leaves a full-frame quad untouched', () => {
    const src = ramp(8, 8);
    const out = warpPixels(src, 8, 8, { tl: { x: 0, y: 0 }, tr: { x: 8, y: 0 }, br: { x: 8, y: 8 }, bl: { x: 0, y: 8 } }, 8, 8);
    // Bilinear sampling sits half a pixel in, so a ramp can differ by one step.
    for (let i = 0; i < out.length; i++) expect(Math.abs(out[i]! - src[i]!)).toBeLessThanOrEqual(1);
  });

  it('scales the left half of the frame across the whole output', () => {
    const w = 100;
    const src = ramp(w, 100);
    const quad: Quad = { tl: { x: 0, y: 0 }, tr: { x: 50, y: 0 }, br: { x: 50, y: 100 }, bl: { x: 0, y: 100 } };
    const out = warpPixels(src, w, 100, quad, 100, 100);
    const red = (u: number, v: number) => out[(v * 100 + u) * 4]!;
    expect(red(0, 50)).toBeLessThan(2);
    expect(red(99, 50)).toBeGreaterThan(47);
    expect(red(99, 50)).toBeLessThan(52);
    // Half way across the output is half way across the source's left half.
    expect(red(50, 50)).toBeGreaterThan(23);
    expect(red(50, 50)).toBeLessThan(28);
  });

  it('pulls a trapezoid square', () => {
    // A card smaller at the top than the bottom, exactly the perspective case.
    const quad: Quad = { tl: { x: 30, y: 0 }, tr: { x: 70, y: 0 }, br: { x: 100, y: 100 }, bl: { x: 0, y: 100 } };
    const src = ramp(100, 100);
    const out = warpPixels(src, 100, 100, quad, 10, 10);
    const red = (u: number, v: number) => out[(v * 10 + u) * 4]!;
    // Top edge of the output samples the narrow edge of the card, bottom the wide one.
    expect(red(0, 0)).toBeGreaterThanOrEqual(28);
    expect(red(0, 0)).toBeLessThanOrEqual(34);
    expect(red(0, 9)).toBeLessThan(15);
    expect(red(9, 9)).toBeGreaterThan(85);
  });
});
