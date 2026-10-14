import { describe, expect, it } from 'vitest';
import { applyH, autoLevels, rectToQuad, rotFwd, rotInv, rotInvDelta, sauvolaBinarize, solveH } from '../scan';

/** SCAN-02: the clean-scan geometry and levels must hold exactly — these run in Node, no canvas. */
describe('clean-scan math', () => {
  it('routes a rectangle through the identity homography', () => {
    const q = rectToQuad(100, 60);
    const h = solveH([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }], [q.tl, q.tr, q.br, q.bl]);
    for (const [dx, dy, want] of [[0, 0, q.tl], [100, 0, q.tr], [100, 60, q.br], [0, 60, q.bl]] as const) {
      const p = applyH(h, dx, dy);
      expect(p.x).toBeCloseTo(want.x, 6);
      expect(p.y).toBeCloseTo(want.y, 6);
    }
  });

  it('un-tilts a trapezoid back onto a rectangle', () => {
    const dst = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 120 }, { x: 0, y: 120 }];
    const src = [{ x: 20, y: 10 }, { x: 180, y: 4 }, { x: 190, y: 116 }, { x: 12, y: 110 }];
    const h = solveH(dst, src);
    for (const [d, s] of dst.map((p, i) => [p, src[i]!] as const)) {
      const p = applyH(h, d.x, d.y);
      expect(p.x).toBeCloseTo(s.x, 6);
      expect(p.y).toBeCloseTo(s.y, 6);
    }
  });

  it('rotation round-trips through all four turns', () => {
    const w = 400;
    const h = 300;
    for (const r of [0, 90, 180, 270]) {
      for (const p of [{ x: 37, y: 251 }, { x: 0, y: 0 }, { x: 400, y: 300 }]) {
        const back = rotInv(rotFwd(p, w, h, r), r === 90 || r === 270 ? h : w, r === 90 || r === 270 ? w : h, r);
        expect(back.x).toBeCloseTo(p.x, 6);
        expect(back.y).toBeCloseTo(p.y, 6);
      }
    }
  });

  it('moves drag deltas through the inverse turn', () => {
    expect(rotInvDelta({ x: 10, y: 0 }, 90)).toEqual({ x: 0, y: -10 });
    expect(rotInvDelta({ x: 10, y: 0 }, 270)).toEqual({ x: 0, y: 10 });
    expect(rotInvDelta({ x: 10, y: 0 }, 180)).toEqual({ x: -10, y: 0 });
  });

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
});
