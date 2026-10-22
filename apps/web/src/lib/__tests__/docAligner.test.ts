import { describe, expect, it } from 'vitest';
import { HEAT_THRESHOLD, INPUT, cornersFromHeatmap, preprocess } from '../docAligner';

/** SCAN-V2 detector: pure pre/post-processing of the DocAligner model (no ORT, no canvas). */

/** Four-channel heatmap with one Gaussian bump per corner, in TL/TR/BR/BL channel order. */
function heatmap(corners: Array<[number, number]>, sigma = 6, amp = 1): Float32Array {
  const n = INPUT * INPUT;
  const heat = new Float32Array(4 * n);
  corners.forEach(([cx, cy], c) => {
    for (let y = 0; y < INPUT; y++) {
      for (let x = 0; x < INPUT; x++) {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2;
        heat[c * n + y * INPUT + x] = amp * Math.exp(-d2 / (2 * sigma * sigma));
      }
    }
  });
  return heat;
}

const CARD: Array<[number, number]> = [[40, 50], [210, 52], [212, 205], [38, 203]];

describe('docAligner heatmap → corners', () => {
  it('finds one corner per channel', () => {
    const q = cornersFromHeatmap(heatmap(CARD));
    expect(q).not.toBeNull();
    const got: Array<[number, number]> = [[q!.tl.x, q!.tl.y], [q!.tr.x, q!.tr.y], [q!.br.x, q!.br.y], [q!.bl.x, q!.bl.y]];
    got.forEach(([x, y], i) => {
      expect(Math.abs(x - CARD[i]![0])).toBeLessThan(1);
      expect(Math.abs(y - CARD[i]![1])).toBeLessThan(1);
    });
  });

  it('refuses a blank frame', () => {
    expect(cornersFromHeatmap(new Float32Array(4 * INPUT * INPUT))).toBeNull();
  });

  it('refuses heat that never reaches the peak gate', () => {
    expect(cornersFromHeatmap(heatmap(CARD, 6, 0.2))).toBeNull();
  });

  it('takes the strongest blob when a channel has two', () => {
    const heat = heatmap(CARD);
    // A decoy corner (a fold, a sticker) with less heat, plus a small but hot speck.
    const n = INPUT * INPUT;
    for (let c = 0; c < 4; c++) {
      for (let y = 120; y < 140; y++) for (let x = 120; x < 140; x++) heat[c * n + y * INPUT + x] = HEAT_THRESHOLD + 0.05;
    }
    const q = cornersFromHeatmap(heat);
    expect(q).not.toBeNull();
    expect(Math.abs(q!.tl.x - 40)).toBeLessThan(1);
    expect(Math.abs(q!.br.x - 212)).toBeLessThan(1);
  });
});

describe('docAligner input tensor', () => {
  it('is BGR, 0–1, three 256×256 planes', () => {
    // One red pixel: the blue plane reads 0, red reads 1.
    const rgba = new Uint8ClampedArray([255, 0, 0, 255]);
    const t = preprocess(rgba, 1, 1);
    const n = INPUT * INPUT;
    expect(t.length).toBe(3 * n);
    expect(t[0]).toBe(0); // B
    expect(t[n]).toBe(0); // G
    expect(t[2 * n]).toBe(1); // R
  });

  it('samples a 2:1 image across the square', () => {
    // Left pixel white, right pixel black — the square's left half must be white.
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
    const t = preprocess(rgba, 2, 1);
    expect(t[0]).toBe(1);
    expect(t[INPUT - 1]).toBe(0);
  });
});
