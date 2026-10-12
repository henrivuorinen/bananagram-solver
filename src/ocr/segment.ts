/**
 * Low-level pixel helpers for tile detection (see tiles.ts).
 * Pure pixel code (no DOM) so it can be unit-tested and reused outside the browser.
 */

export interface GrayImage {
  width: number;
  height: number;
  /** One byte per pixel, 0 = black. */
  data: Uint8Array;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function toGray(rgba: Uint8ClampedArray, width: number, height: number): GrayImage {
  const data = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    data[i] = (rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114) / 1000;
  }
  return { width, height, data };
}

/**
 * Adaptive threshold: a pixel is "ink" when it is clearly darker than its neighbourhood.
 * Copes with shadows and uneven lighting far better than one global cut-off.
 */
export function binarize(img: GrayImage, windowFrac = 1 / 12, bias = 0.15): Uint8Array {
  const { width: W, height: H, data } = img;
  const integral = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += data[y * W + x];
      integral[(y + 1) * (W + 1) + x + 1] = integral[y * (W + 1) + x + 1] + row;
    }
  }
  const half = Math.max(4, Math.round((Math.min(W, H) * windowFrac) / 2));
  const ink = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - half), y1 = Math.min(H, y + half + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - half), x1 = Math.min(W, x + half + 1);
      const sum =
        integral[y1 * (W + 1) + x1] - integral[y0 * (W + 1) + x1] - integral[y1 * (W + 1) + x0] + integral[y0 * (W + 1) + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      if (data[y * W + x] < mean * (1 - bias)) ink[y * W + x] = 1;
    }
  }
  return ink;
}

export interface Component extends Box {
  area: number;
}

export function components(ink: Uint8Array, W: number, H: number): Component[] {
  const label = new Int32Array(W * H);
  const out: Component[] = [];
  const stack: number[] = [];
  let next = 1;
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || label[start]) continue;
    let minX = W, minY = H, maxX = 0, maxY = 0, area = 0;
    label[start] = next;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % W, y = (p - x) / W;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= W) continue;
          const q = ny * W + nx;
          if (ink[q] && !label[q]) {
            label[q] = next;
            stack.push(q);
          }
        }
      }
    }
    next++;
    out.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area });
  }
  return out;
}

export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};
