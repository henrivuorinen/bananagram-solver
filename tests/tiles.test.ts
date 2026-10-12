import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import type { Lang } from '../src/solver/dictionary';
import { readTile } from '../src/ocr/classify';
import { chooseReading, type Choice } from '../src/ocr/reading';
import { toGray } from '../src/ocr/segment';
import { findTiles } from '../src/ocr/tiles';

function read(file: string, lang: Lang, noise = 0, seed = 1) {
  const png = PNG.sync.read(readFileSync(join(__dirname, 'fixtures', file)));
  const img = toGray(new Uint8ClampedArray(png.data), png.width, png.height);
  if (noise) {
    // Tiny pixel jitter, like the rounding differences between browsers and devices.
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    img.data = img.data.map((v) => Math.max(0, Math.min(255, v + Math.round((rnd() - 0.5) * noise))));
  }
  return findTiles(img).map((t) => ({
    x: t.cx,
    y: t.cy,
    ...(chooseReading(readTile(t, lang), lang) as Choice),
  }));
}

/** A misread is acceptable only if the tile is flagged for checking and the right letter is offered. */
const flaggedWithFix = (c: Choice, truth: string) => c.unsure && c.alternatives.slice(0, 4).includes(truth);

describe('tile recognition', () => {
  it('reads upright English tiles', () => {
    const got = read('tiles-en.png', 'en');
    expect(got).toHaveLength(21);
    [...'BANANASPLITQUZXJORDEW'].forEach((truth, i) => {
      if (got[i].letter !== truth) expect(flaggedWithFix(got[i], truth)).toBe(true);
    });
  });

  it('reads Finnish tiles, keeping umlaut dots with their letter', () => {
    expect(read('tiles-fi.png', 'fi').map((c) => c.letter).join('')).toBe('TALOÄITIÖLJYKISSAVENE');
  });

  it('reads tiles turned to any angle', () => {
    expect(read('tiles-rotated.png', 'en').map((c) => c.letter).join('')).toBe('ROTATEDTILESAREREADOK');
  });

  // Every fully visible tile in tests/photos/IMG_4358.jpg, as [x, y, letter] in the 1050×1400
  // fixtures. Turned N/Z and M/W look identical, so either reading counts.
  const truth: [number, number, string][] = [
    [298, 290, 'I'], [395, 247, 'S'], [395, 322, 'Ä'], [713, 380, 'N|Z'], [575, 452, 'U'], [605, 505, 'E'],
    [685, 470, 'L'], [322, 548, 'A'], [428, 568, 'U'], [648, 598, 'N|Z'], [405, 658, 'P'], [260, 672, 'I'],
    [200, 725, 'A'], [395, 742, 'O'], [762, 730, 'T'], [35, 765, 'E'], [195, 792, 'K'], [333, 866, 'E'],
    [405, 860, 'L'], [465, 845, 'M|W'], [42, 880, 'V'], [400, 915, 'U'], [765, 935, 'S'], [482, 993, 'J'],
    [370, 1015, 'Ä'], [432, 1083, 'K'], [518, 1095, 'T'], [118, 1155, 'H'], [90, 1222, 'S'], [190, 1240, 'L'],
    [442, 1188, 'M'], [365, 1240, 'V'], [493, 1275, 'R'], [607, 1258, 'S'], [95, 1318, 'U'], [1007, 210, 'Ä'],
  ];

  function score(got: ReturnType<typeof read>) {
    const used = new Set<number>();
    let correct = 0;
    for (const [x, y, letters] of truth) {
      const j = got.findIndex((g, k) => !used.has(k) && Math.hypot(g.x - x, g.y - y) < 25);
      if (j < 0) continue;
      used.add(j);
      const ok = letters.split('|');
      if (ok.includes(got[j].letter)) correct++;
      else expect(ok.some((l) => flaggedWithFix(got[j], l))).toBe(true);
    }
    return { correct, phantoms: got.length - used.size };
  }

  // The same photo downscaled three ways: Pillow, and the browser's low/high smoothing.
  it.each(['real-fi-1.png', 'real-fi-1-browser-low.png', 'real-fi-1-browser-high.png'])(
    'reads a real photo of scattered, rotated tiles (%s)',
    (file) => {
      const { correct, phantoms } = score(read(file, 'fi'));
      // 35/36: the S pressed against the laptop's dark shadow is not found yet.
      expect(correct).toBeGreaterThanOrEqual(35);
      // No phantom tiles from shadows or wood grain, and no half-visible tiles at the border.
      expect(phantoms).toBe(0);
    },
  );

  it('gives the same answer when pixels jitter slightly', () => {
    for (const seed of [3, 5, 7]) {
      expect(score(read('real-fi-1-browser-high.png', 'fi', 4, seed))).toEqual({ correct: 35, phantoms: 0 });
    }
  }, 30000);
});
