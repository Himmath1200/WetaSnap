import { describe, expect, it } from 'vitest';
import {
  QUAD_MIN_SCORE, QUAD_MIN_SUPPORT, edgeSupport, orderQuadPoints, outputSizeFor,
  quadArea, quadAspect, quadIsSane, quadsClose, scaleQuad, scoreQuad, type Quad,
} from '../scanEngine';

/** SCAN-V2: corner geometry guards — these run in Node, no OpenCV. */
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
});

/** SCAN-V2 busy backgrounds: quads earn the lock with real edge support, not size. */
describe('pro scanner quad scoring', () => {
  const W = 100;
  const H = 100;

  /** A Canny-style edge map with just the border of the given rect set. */
  function edgeMap(rect: Quad): Uint8Array {
    const e = new Uint8Array(W * H);
    const line = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
      for (let i = 0; i <= n; i++) {
        e[Math.round(a.y + ((b.y - a.y) * i) / n) * W + Math.round(a.x + ((b.x - a.x) * i) / n)] = 255;
      }
    };
    line(rect.tl, rect.tr); line(rect.tr, rect.br); line(rect.br, rect.bl); line(rect.bl, rect.tl);
    return e;
  }

  const onCard: Quad = { tl: { x: 20, y: 30 }, tr: { x: 80, y: 30 }, br: { x: 80, y: 70 }, bl: { x: 20, y: 70 } };
  // The busy-background failure: a bigger convex quad around the card, no edges behind it.
  const phantom: Quad = { tl: { x: 5, y: 10 }, tr: { x: 95, y: 15 }, br: { x: 90, y: 90 }, bl: { x: 8, y: 85 } };

  it('orders shuffled contour vertices', () => {
    const q = orderQuadPoints([{ x: 80, y: 70 }, { x: 20, y: 70 }, { x: 80, y: 30 }, { x: 20, y: 30 }]);
    expect(q).toEqual(onCard);
  });

  it('measures proportions orientation-free', () => {
    expect(quadAspect({ tl: { x: 0, y: 0 }, tr: { x: 856, y: 0 }, br: { x: 856, y: 540 }, bl: { x: 0, y: 540 } })).toBeCloseTo(1.585, 2);
    expect(quadAspect(onCard)).toBeCloseTo(1.5, 2);
  });

  it('supports only outlines that sit on edges', () => {
    const edges = edgeMap(onCard);
    expect(edgeSupport(onCard, edges, W, H)).toBeGreaterThan(0.95);
    expect(edgeSupport(phantom, edges, W, H)).toBeLessThan(0.2);
    expect(edgeSupport(onCard, new Uint8Array(W * H), W, H)).toBe(0);
  });

  it('the supported card wins; the phantom never passes', () => {
    const edges = edgeMap(onCard);
    expect(edgeSupport(phantom, edges, W, H)).toBeLessThan(QUAD_MIN_SUPPORT);
    const cardScore = scoreQuad(onCard, W, H, edges);
    const phantomScore = scoreQuad(phantom, W, H, edges);
    expect(cardScore).toBeGreaterThan(QUAD_MIN_SCORE);
    expect(cardScore).toBeGreaterThan(phantomScore);
  });
});
