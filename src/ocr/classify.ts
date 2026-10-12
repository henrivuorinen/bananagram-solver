/**
 * Recognises a straightened tile letter by comparing its shape with rendered letter templates.
 * Every tile uses the same plain font, so template matching is both more reliable and far
 * faster than general-purpose OCR, and it needs no model files.
 */
import type { Lang } from '../solver/dictionary';
import type { Reading } from './reading';
import type { GrayImage } from './segment';
import { TEMPLATES } from './templates';
import { rotateGlyph, type TileGlyph } from './tiles';

const TEMPLATE_GRID = 40;
const TEMPLATE_FIT = 32;
const BLUR_SIGMA = 1.5;

export const ALPHABET: Record<Lang, string> = {
  en: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  fi: 'ABCDEFGHIJKLMNOPQRSTUVWXYZÅÄÖ',
};

/** How many separate shapes each letter is drawn with, where it isn't one. */
const PARTS: Record<string, number> = { Ä: 3, Ö: 3, Å: 2 };
const PARTS_PENALTY = 8;

const KERNEL = (() => {
  const r = Math.ceil(BLUR_SIGMA * 3);
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * BLUR_SIGMA ** 2)));
  const sum = k.reduce((a, b) => a + b, 0);
  return k.map((v) => v / sum);
})();

/** Gaussian blur, then zero mean and unit length, so a dot product is a correlation in −1…1. */
function toVector(ink: Float32Array): Float32Array {
  const n = TEMPLATE_GRID, r = (KERNEL.length - 1) / 2;
  const tmp = new Float32Array(n * n);
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i;
        if (xx >= 0 && xx < n) s += ink[y * n + xx] * KERNEL[i + r];
      }
      tmp[y * n + x] = s;
    }
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const yy = y + i;
        if (yy >= 0 && yy < n) s += tmp[yy * n + x] * KERNEL[i + r];
      }
      out[y * n + x] = s;
    }
  let mean = 0;
  for (const v of out) mean += v;
  mean /= out.length;
  let norm = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] -= mean;
    norm += out[i] * out[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/** Scales a black-on-white glyph so its ink fits TEMPLATE_FIT px, centred like the templates. */
function glyphVector(g: GrayImage): Float32Array | null {
  let x0 = g.width, y0 = g.height, x1 = -1, y1 = -1;
  for (let y = 0; y < g.height; y++)
    for (let x = 0; x < g.width; x++)
      if (g.data[y * g.width + x] < 128) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const k = TEMPLATE_FIT / Math.max(w, h);
  const ow = Math.max(1, Math.round(w * k)), oh = Math.max(1, Math.round(h * k));
  const ox = Math.floor((TEMPLATE_GRID - ow) / 2), oy = Math.floor((TEMPLATE_GRID - oh) / 2);
  const ink = new Float32Array(TEMPLATE_GRID * TEMPLATE_GRID);
  // Area-average 3×3 samples per output pixel.
  for (let y = 0; y < oh; y++)
    for (let x = 0; x < ow; x++) {
      let s = 0;
      for (let sy = 0; sy < 3; sy++)
        for (let sx = 0; sx < 3; sx++) {
          const gx = Math.min(x1, Math.floor(x0 + (x + (sx + 0.5) / 3) / k));
          const gy = Math.min(y1, Math.floor(y0 + (y + (sy + 0.5) / 3) / k));
          if (g.data[gy * g.width + gx] < 128) s++;
        }
      ink[(y + oy) * TEMPLATE_GRID + x + ox] = s / 9;
    }
  return toVector(ink);
}

let templateVectors: Map<string, Float32Array[]> | null = null;

function templates(): Map<string, Float32Array[]> {
  if (templateVectors) return templateVectors;
  templateVectors = new Map();
  for (const [ch, list] of Object.entries(TEMPLATES)) {
    templateVectors.set(
      ch,
      list.map((b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const ink = new Float32Array(TEMPLATE_GRID * TEMPLATE_GRID);
        for (let i = 0; i < ink.length; i++) ink[i] = (bytes[i >> 3] >> (i & 7)) & 1;
        return toVector(ink);
      }),
    );
  }
  return templateVectors;
}

/** Scores every letter of the language against the tile, in all four orientations. */
export function readTile(tile: Pick<TileGlyph, 'glyph' | 'isBar' | 'parts'>, lang: Lang): Reading[] {
  if (tile.isBar) return [{ letter: 'I', confidence: 99 }];
  const turns = [0, 1, 2, 3].map((q) => glyphVector(rotateGlyph(tile.glyph, q))).filter((v) => v !== null);
  const readings: Reading[] = [];
  for (const ch of ALPHABET[lang]) {
    let best = -1;
    for (const t of templates().get(ch) ?? [])
      for (const g of turns) {
        let dot = 0;
        for (let i = 0; i < g.length; i++) dot += g[i] * t[i];
        if (dot > best) best = dot;
      }
    // Two separate dots are strong evidence of Ä/Ö. The reverse doesn't hold: in photos the
    // dots often blur into the letter, so a single shape says nothing either way.
    const dotted = (PARTS[ch] ?? 1) === 3;
    const penalty = tile.parts >= 3 && !dotted ? PARTS_PENALTY : 0;
    readings.push({ letter: ch, confidence: best * 100 - penalty });
  }
  return readings;
}
