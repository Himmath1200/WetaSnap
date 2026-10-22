import { describe, expect, it } from 'vitest';
import { INPUT, cornersFromHeatmap, toInput } from '../docAligner';

/** SCAN-V2: the model's preprocessing and heatmap decoding — pure, no ORT. */
describe('card-corner model', () => {
  it('feeds BGR planes scaled to 0–1, channel first', () => {
    const rgba = new Uint8ClampedArray(INPUT * INPUT * 4);
    rgba[0] = 10; rgba[1] = 20; rgba[2] = 30; rgba[3] = 255; // one red-ish pixel
    const x = toInput(rgba);
    const n = INPUT * INPUT;
    expect(x).toHaveLength(3 * n);
    expect(x[0]).toBeCloseTo(30 / 255, 6);      // B
    expect(x[n]).toBeCloseTo(20 / 255, 6);      // G
    expect(x[2 * n]).toBeCloseTo(10 / 255, 6);  // R
  });

  it('decodes one corner per heatmap channel', () => {
    const size = 4;
    const heat = new Float32Array(4 * size * size);
    const put = (c: number, x: number, y: number, v: number) => { heat[c * size * size + y * size + x] = v; };
    put(0, 0, 0, 0.9); put(1, 3, 0, 0.8); put(2, 3, 3, 0.7); put(3, 0, 3, 0.6);
    const { pts, confidence } = cornersFromHeatmap(heat, size);
    expect(pts.map((p) => [p.x, p.y])).toEqual([[0.5, 0.5], [3.5, 0.5], [3.5, 3.5], [0.5, 3.5]]);
    expect(confidence).toBeCloseTo(0.6, 6); // the weakest corner decides
  });

  it('reports near-zero confidence for an empty frame', () => {
    const { confidence } = cornersFromHeatmap(new Float32Array(4 * INPUT * INPUT));
    expect(confidence).toBe(0);
  });
});
