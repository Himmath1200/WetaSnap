import { describe, expect, it } from 'vitest';
import { analyseFrame, placement, type Placement } from '../image';

/**
 * Auto-capture must fire at a business card, a badge or a QR code — and at nothing else. These
 * frames stand in for what the camera sees: the guide area, 160 × 100 (SCAN-01).
 */
const W = 160;
const H = 100;

function frame(paint: (set: (x: number, y: number, v: number) => void) => void): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4);
  const set = (x: number, y: number, v: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  };
  paint(set);
  return data;
}

const fill = (v: number) => frame((set) => { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, v); });

/** A flat card with a few lines of print, filling the guide. */
function businessCard({ inset = 0, body = 235, print = 30 } = {}) {
  return frame((set) => {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const onCard = x >= inset && x < W - inset && y >= inset && y < H - inset;
        set(x, y, onCard ? body : 70); // outside the card: a darker desk
      }
    }
    const lines = [[20, 28, 90], [20, 44, 120], [20, 58, 70], [20, 70, 100]];
    for (const [x0, y0, len] of lines) {
      for (let x = x0!; x < x0! + len!; x++) { set(x + inset, y0! + inset, print); set(x + inset, y0! + 1 + inset, print); }
    }
  });
}

/** A QR code: a flat sheet with dense black blocks. */
const qrCode = () => frame((set) => {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, 240);
  for (let by = 20; by < 80; by += 8) {
    for (let bx = 45; bx < 115; bx += 8) {
      const on = (bx * 7 + by * 13) % 3 !== 0;
      for (let y = by; y < by + 6; y++) for (let x = bx; x < bx + 6; x++) set(x, y, on ? 20 : 240);
    }
  }
});

/** A cluttered desk: texture everywhere, no flat surface. */
const desk = () => frame((set) => {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, 60 + ((x * 37 + y * 91) % 150));
});

const verdict = (data: Uint8ClampedArray): Placement => placement(analyseFrame(data, W, H));

describe('auto-capture placement', () => {
  it('fires at a business card that fills the frame', () => {
    expect(verdict(businessCard())).toBe('ok');
  });

  it('fires at a dark card with light print — a card need not be white', () => {
    expect(verdict(businessCard({ body: 60, print: 215 }))).toBe('ok');
  });

  it('fires at a QR code or badge', () => {
    expect(verdict(qrCode())).toBe('ok');
  });

  it('does not fire at a cluttered desk', () => {
    expect(verdict(desk())).toBe('none');
  });

  it('does not fire at a blank surface — a table, a wall, an empty sheet', () => {
    expect(verdict(fill(230))).toBe('blank');
    expect(verdict(fill(90))).toBe('blank');
  });

  it('asks the person to come closer when the card does not fill the frame', () => {
    expect(verdict(businessCard({ inset: 22 }))).toBe('far');
  });

  it('does not fire at a hand or a wall filling the view', () => {
    const smooth = frame((set) => {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) set(x, y, 150 + Math.round(40 * Math.sin(x / 9)) + Math.round(25 * Math.sin(y / 7)));
      }
    });
    expect(verdict(smooth)).toBe('none');
  });

  it('reports what it measured, so the numbers can be tuned', () => {
    const c = analyseFrame(businessCard(), W, H);
    expect(c.centre).toBeGreaterThan(0.6);
    expect(c.ink).toBeGreaterThan(0.01);
    expect(c.ring).toBeGreaterThan(0.9);
    expect(c.edges).toBeLessThan(0.35);
  });
});
