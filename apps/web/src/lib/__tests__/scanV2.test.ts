import { describe, expect, it } from 'vitest';
import {
  homography, orderQuadPoints, outputSizeFor, quadArea, quadAspect, quadIsSane, quadsClose,
  scaleQuad, warpPixels, type Pt, type Quad,
} from '../scanEngine';

/** SCAN-V2: corner geometry + the warp — these run in Node, no canvas runtime. */
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

  it('sizes the warp to the card proportions at 2000 px', () => {
    const { w, h } = outputSizeFor({ tl: { x: 0, y: 0 }, tr: { x: 856, y: 0 }, br: { x: 856, y: 540 }, bl: { x: 0, y: 540 } });
    expect(w).toBe(2000);
    expect(h).toBe(1262); // ID-1 ratio, not a square
  });

  it('orders shuffled corners', () => {
    const q = orderQuadPoints([{ x: 80, y: 70 }, { x: 20, y: 70 }, { x: 80, y: 30 }, { x: 20, y: 30 }]);
    expect(q).toEqual({ tl: { x: 20, y: 30 }, tr: { x: 80, y: 30 }, br: { x: 80, y: 70 }, bl: { x: 20, y: 70 } });
  });

  it('measures proportions orientation-free', () => {
    expect(quadAspect({ tl: { x: 0, y: 0 }, tr: { x: 856, y: 0 }, br: { x: 856, y: 540 }, bl: { x: 0, y: 540 } })).toBeCloseTo(1.585, 2);
  });
});

describe('pro scanner warp', () => {
  // Node has no ImageData; the warp only ever uses width/height/data.
  class TestImageData {
    data: Uint8ClampedArray;
    constructor(public width: number, public height: number) {
      this.data = new Uint8ClampedArray(width * height * 4);
    }
  }
  (globalThis as unknown as { ImageData: unknown }).ImageData ??= TestImageData;

  const apply = (m: number[], x: number, y: number): Pt => {
    const den = m[6]! * x + m[7]! * y + 1;
    return {
      x: (m[0]! * x + m[1]! * y + m[2]!) / den,
      y: (m[3]! * x + m[4]! * y + m[5]!) / den,
    };
  };

  it('maps the output rectangle onto the quad corners', () => {
    const q: Quad = { tl: { x: 12, y: 20 }, tr: { x: 200, y: 8 }, br: { x: 214, y: 120 }, bl: { x: 4, y: 132 } };
    const m = homography(q, 300, 190);
    expect(m).not.toBeNull();
    for (const [x, y, want] of [[0, 0, q.tl], [300, 0, q.tr], [300, 190, q.br], [0, 190, q.bl]] as const) {
      const got = apply(m!, x, y);
      expect(got.x).toBeCloseTo(want.x, 6);
      expect(got.y).toBeCloseTo(want.y, 6);
    }
  });

  it('refuses a degenerate quad', () => {
    const line: Quad = { tl: { x: 0, y: 0 }, tr: { x: 10, y: 0 }, br: { x: 20, y: 0 }, bl: { x: 5, y: 0 } };
    expect(homography(line, 100, 100)).toBeNull();
  });

  it('pulls a sub-rectangle out of the frame, left edge in place', () => {
    const src = new ImageData(8, 8);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const o = (y * 8 + x) * 4;
      src.data[o] = x * 10; src.data[o + 1] = y * 10; src.data[o + 2] = 0; src.data[o + 3] = 255;
    }
    // Crop columns 2..6 out of the 8-wide frame.
    const out = warpPixels(src, 8, 8, { tl: { x: 2, y: 0 }, tr: { x: 6, y: 0 }, br: { x: 6, y: 8 }, bl: { x: 2, y: 8 } }, 4, 8);
    expect(out.width).toBe(4);
    expect(out.data[0]).toBeCloseTo(25, 0); // dest x 0.5 → src x 2.5 → 25
    expect(out.data[4]).toBeCloseTo(35, 0); // one column over
    expect(out.data[(1 * 4 + 1) * 4 + 1]).toBeCloseTo(15, 0); // dest row 1 → src row 1.5, green ramps
  });
});
