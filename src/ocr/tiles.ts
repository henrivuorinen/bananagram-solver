/**
 * Tile-first letter detection that copes with tiles lying at any angle.
 *
 * For every letter-like dark shape we look at the tile around it, measure the tile's
 * rotation from its straight edges, and cut out a straightened copy of the letter.
 * Straightening leaves only four possible orientations (0°, 90°, 180°, 270°) for the
 * recognizer to try, instead of an arbitrary angle.
 *
 * Pure pixel code (no DOM) so it can be unit-tested and reused outside the browser.
 */
import { binarize, components, median, type Box, type GrayImage } from './segment';

export interface TileGlyph {
  /** Centre of the letter in image coordinates. */
  cx: number;
  cy: number;
  /** Tile rotation in radians, modulo a quarter turn (−π/4…π/4). */
  angle: number;
  /** Axis-aligned box around the letter in image coordinates, for drawing. */
  box: Box;
  /** Straightened letter, black on white. Still turned by an unknown multiple of 90°. */
  glyph: GrayImage;
  /** A single straight bar: an I, whichever way the tile lies. */
  isBar: boolean;
  /** Separate shapes the letter is made of: 3 for Ä and Ö (letter + two dots), usually 1 otherwise. */
  parts: number;
}

const GLYPH_SIZE = 56;
const GLYPH_MARGIN = 16;

/**
 * Dominant edge direction (mod 90°) in a ring around (cx, cy). The ring skips the letter
 * itself and covers the tile's edges, so diagonal strokes (A, V, N…) don't skew the result.
 * Averaging 4θ makes edges that are 90° apart reinforce each other instead of cancelling.
 */
function tileAngle(img: GrayImage, cx: number, cy: number, inner: number, outer: number): number {
  const { width: W, height: H, data } = img;
  let sc = 0, ss = 0;
  const x0 = Math.max(1, Math.floor(cx - outer)), x1 = Math.min(W - 2, Math.ceil(cx + outer));
  const y0 = Math.max(1, Math.floor(cy - outer)), y1 = Math.min(H - 2, Math.ceil(cy + outer));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      if (d2 < inner * inner || d2 > outer * outer) continue;
      const p = y * W + x;
      const gx =
        data[p - W + 1] + 2 * data[p + 1] + data[p + W + 1] - data[p - W - 1] - 2 * data[p - 1] - data[p + W - 1];
      const gy =
        data[p + W - 1] + 2 * data[p + W] + data[p + W + 1] - data[p - W - 1] - 2 * data[p - W] - data[p - W + 1];
      const m2 = gx * gx + gy * gy;
      if (m2 < 400) continue; // flat surface or faint wood grain
      const t = Math.atan2(gy, gx) * 4;
      const m = Math.sqrt(m2);
      sc += m * Math.cos(t);
      ss += m * Math.sin(t);
    }
  }
  return Math.atan2(ss, sc) / 4;
}

/** A size × size patch centred on (cx, cy), rotated by −angle so the tile's edges run straight. */
function straightPatch(img: GrayImage, cx: number, cy: number, angle: number, size: number): GrayImage {
  const { width: W, height: H, data: src } = img;
  const data = new Uint8Array(size * size);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const half = size / 2;
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      const du = u - half + 0.5, dv = v - half + 0.5;
      const x = cx + du * cos - dv * sin;
      const y = cy + du * sin + dv * cos;
      const xi = Math.floor(x), yi = Math.floor(y);
      if (xi < 0 || yi < 0 || xi >= W - 1 || yi >= H - 1) {
        data[v * size + u] = 255;
        continue;
      }
      const fx = x - xi, fy = y - yi, p = yi * W + xi;
      data[v * size + u] =
        (src[p] * (1 - fx) + src[p + 1] * fx) * (1 - fy) + (src[p + W] * (1 - fx) + src[p + W + 1] * fx) * fy;
    }
  }
  return { width: size, height: size, data };
}

const percentile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
};

/** Scales the ink inside `box` of a binary patch to a fixed-size, centred, black-on-white glyph. */
function normalizeGlyph(ink: Uint8Array, patchSize: number, box: Box): GrayImage {
  const side = GLYPH_SIZE + 2 * GLYPH_MARGIN;
  const data = new Uint8Array(side * side).fill(255);
  const scale = GLYPH_SIZE / Math.max(box.w, box.h);
  for (let Y = 0; Y < side; Y++) {
    for (let X = 0; X < side; X++) {
      const sx = Math.floor((X - side / 2) / scale + box.x + box.w / 2);
      const sy = Math.floor((Y - side / 2) / scale + box.y + box.h / 2);
      if (sx < box.x || sy < box.y || sx >= box.x + box.w || sy >= box.y + box.h) continue;
      if (ink[sy * patchSize + sx]) data[Y * side + X] = 0;
    }
  }
  return { width: side, height: side, data };
}

/** Turns a square glyph by quarterTurns × 90° clockwise. */
export function rotateGlyph(g: GrayImage, quarterTurns: number): GrayImage {
  const n = g.width;
  const t = ((quarterTurns % 4) + 4) % 4;
  if (t === 0) return g;
  const data = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const [sx, sy] = t === 1 ? [y, n - 1 - x] : t === 2 ? [n - 1 - x, n - 1 - y] : [n - 1 - y, x];
      data[y * n + x] = g.data[sy * n + sx];
    }
  }
  return { width: n, height: n, data };
}

interface Inspection {
  tile: TileGlyph;
  /** Letter size measured on the straightened glyph. */
  size: number;
  /** How convincingly this is a letter on a tile: edges seen on more sides, letter centred. */
  quality: number;
}

/** Straightens the area around one candidate shape and checks it is a letter on a tile. */
function inspect(img: GrayImage, cx: number, cy: number, L: number): Inspection | null {
  const angle = tileAngle(img, cx, cy, 0.65 * L, 1.35 * L);
  // Large enough to reach past the tile's edges on every side of the letter.
  const size = Math.round(4 * L);
  const patch = straightPatch(img, cx, cy, angle, size);
  const c = size / 2;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const inPhoto = (u: number, v: number) => {
    const du = u - c + 0.5, dv = v - c + 0.5;
    const x = cx + du * cos - dv * sin, y = cy + du * sin + dv * cos;
    return x >= 0 && y >= 0 && x < img.width - 1 && y < img.height - 1;
  };

  // Brightness of the tile surface vs. the ink, sampled where the tile must be.
  const near: number[] = [];
  const r = 0.7 * L;
  for (let y = Math.floor(c - r); y < c + r; y++) for (let x = Math.floor(c - r); x < c + r; x++) near.push(patch.data[y * size + x]);
  const surface = percentile(near, 0.8);
  const inkLevel = percentile(near, 0.03);
  const contrast = surface - inkLevel;
  if (contrast < 35) return null;
  const cut = inkLevel + contrast * 0.5;

  const ink = new Uint8Array(size * size);
  for (let i = 0; i < ink.length; i++) ink[i] = patch.data[i] < cut ? 1 : 0;

  // Keep the shapes that sit inside the letter area of the tile: the letter and any umlaut dots.
  // Anything reaching out towards the tile's edge is a shadow, an edge or a neighbouring tile.
  const letterR = 0.62 * L, limitR = 0.9 * L;
  const candidatesNearCentre = components(ink, size, size).filter((k) => {
    if (k.area < Math.max(4, 0.004 * L * L)) return false;
    const touches = k.x < c + letterR && k.x + k.w > c - letterR && k.y < c + letterR && k.y + k.h > c - letterR;
    const contained = k.x > c - limitR && k.x + k.w < c + limitR && k.y > c - limitR && k.y + k.h < c + limitR;
    return touches && contained;
  });
  const main = candidatesNearCentre.reduce<(typeof candidatesNearCentre)[number] | null>((a, k) => (!a || k.area > a.area ? k : a), null);
  if (!main || Math.max(main.w, main.h) < 0.45 * L) return null;
  // Keep pieces of the letter and its umlaut dots; drop slivers of the tile edge and noise.
  // Dots sit just beyond one end of the letter, lined up with it (above it, in the tile's own
  // orientation); a speck off to the side near a corner is dirt or a neighbouring tile.
  const mx = main.x + main.w / 2, my = main.y + main.h / 2, reach = 0.72 * L;
  const margin = 0.1 * L;
  const kept = candidatesNearCentre.filter((k) => {
    if (k === main) return true;
    if (k.area < 0.006 * L * L) return false;
    const kx = k.x + k.w / 2, ky = k.y + k.h / 2;
    const inside = k.x >= mx - reach && k.x + k.w <= mx + reach && k.y >= my - reach && k.y + k.h <= my + reach;
    const gap = Math.max(main.x - (k.x + k.w), k.x - (main.x + main.w), main.y - (k.y + k.h), k.y - (main.y + main.h), 0);
    const alignedX = kx > main.x - margin && kx < main.x + main.w + margin;
    const alignedY = ky > main.y - margin && ky < main.y + main.h + margin;
    const dot = Math.max(k.w, k.h) < 0.3 * L && gap < 0.3 * L && alignedX !== alignedY;
    return (inside && (alignedX || alignedY)) || dot;
  });

  // The surface around the letter must be an even tile colour, not wood grain or a shadow edge.
  const keep = new Uint8Array(size * size);
  const lit: number[] = [];
  for (const k of kept) for (let y = k.y; y < k.y + k.h; y++) for (let x = k.x; x < k.x + k.w; x++) keep[y * size + x] = 1;
  for (let y = Math.floor(c - r); y < c + r; y++)
    for (let x = Math.floor(c - r); x < c + r; x++) if (!keep[y * size + x]) lit.push(patch.data[y * size + x]);
  const spread = percentile(lit, 0.9) - percentile(lit, 0.1);
  if (spread > 0.45 * contrast) return null;

  const x0 = Math.min(...kept.map((k) => k.x)), y0 = Math.min(...kept.map((k) => k.y));
  const x1 = Math.max(...kept.map((k) => k.x + k.w)), y1 = Math.max(...kept.map((k) => k.y + k.h));
  const glyphBox = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };

  // A real tile shows its edge on (nearly) every side, roughly half a tile from the letter.
  // Shadows, tile edges and wood grain fail this check, and so do tiles cut off by the photo's border.
  // The table can be lighter or darker than the tiles, so an edge is any lasting change from the
  // tile's own surface brightness next to the letter.
  const gxc = x0 + glyphBox.w / 2, gyc = y0 + glyphBox.h / 2;
  const band = Math.max(2, Math.round(0.2 * L));
  const step = Math.max(10, 0.1 * contrast);
  let edges = 0;
  const dist: number[] = [];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    dist.push(NaN);
    const start = Math.ceil((dx ? glyphBox.w : glyphBox.h) / 2) + 2;
    let level = -1, changed = 0;
    for (let d = start; d < 1.4 * L; d++) {
      let sum = 0;
      for (let t = -band; t <= band; t++) {
        const u = Math.round(gxc + dx * d + dy * t), v = Math.round(gyc + dy * d + dx * t);
        if (u < 0 || v < 0 || u >= size || v >= size || !inPhoto(u, v)) return null;
        sum += patch.data[v * size + u];
      }
      const mean = sum / (2 * band + 1);
      if (level < 0) level = mean;
      if (Math.abs(mean - level) < step) {
        changed = 0;
        level = 0.8 * level + 0.2 * mean; // follow gentle shading across the tile
      } else if (++changed === 2) {
        if (d >= 0.35 * L) {
          edges++;
          dist[dist.length - 1] = d;
        }
        break;
      }
    }
  }
  if (edges < 3) return null;
  // On a real tile the letter sits in the middle: opposite edges are about equally far away.
  const off = (a: number, b: number) => (Number.isNaN(a) || Number.isNaN(b) ? 0.5 * L : Math.abs(a - b));
  const quality = edges - (off(dist[0], dist[1]) + off(dist[2], dist[3])) / L;

  // Only the kept shapes go into the glyph: clear everything else in the patch.
  const clean = new Uint8Array(size * size);
  for (const k of kept)
    for (let y = k.y; y < k.y + k.h; y++) for (let x = k.x; x < k.x + k.w; x++) clean[y * size + x] = ink[y * size + x];

  const long = Math.max(main.w, main.h), short = Math.min(main.w, main.h);
  const isBar = kept.length === 1 && long / short > 3.5 && main.area / (main.w * main.h) > 0.6;

  // Map the straightened glyph's centre and corners back into the photo.
  const gcx = x0 + glyphBox.w / 2 - c, gcy = y0 + glyphBox.h / 2 - c;
  const icx = cx + gcx * cos - gcy * sin, icy = cy + gcx * sin + gcy * cos;
  const ext = (Math.abs(glyphBox.w * cos) + Math.abs(glyphBox.h * sin)) / 2;
  const eyt = (Math.abs(glyphBox.w * sin) + Math.abs(glyphBox.h * cos)) / 2;

  return {
    size: long,
    quality,
    tile: {
      cx: icx,
      cy: icy,
      angle,
      box: { x: Math.round(icx - ext), y: Math.round(icy - eyt), w: Math.round(2 * ext), h: Math.round(2 * eyt) },
      glyph: normalizeGlyph(clean, size, glyphBox),
      isBar,
      parts: kept.length,
    },
  };
}

/** Finds every tile's letter in the photo, in reading order (top-to-bottom, left-to-right). */
export function findTiles(img: GrayImage): TileGlyph[] {
  const { width: W, height: H } = img;
  const minSide = Math.min(W, H);

  const candidates = components(binarize(img), W, H).filter((k) => {
    const long = Math.max(k.w, k.h), short = Math.min(k.w, k.h);
    return (
      long >= minSide * 0.015 && long <= minSide * 0.2 && short >= 2 &&
      k.area / (k.w * k.h) >= 0.08 &&
      k.x > 0 && k.y > 0 && k.x + k.w < W && k.y + k.h < H
    );
  });
  if (!candidates.length) return [];

  // Outlines and shadows around a tile enclose its letter; they say nothing about letter size.
  const encloses = (o: Box, k: Box) =>
    o !== k && k.x > o.x && k.y > o.y && k.x + k.w < o.x + o.w && k.y + k.h < o.y + o.h;
  const letterLike = candidates.filter(
    (k) => Math.max(k.w, k.h) / Math.min(k.w, k.h) < 3 && !candidates.some((o) => encloses(k, o) && o.h > k.h * 0.3),
  );

  // First pass with a rough letter size, then a second pass with the size of confirmed letters.
  let L = median(letterLike.map((k) => Math.max(k.w, k.h)));
  let found: Inspection[] = [];
  for (let pass = 0; pass < 2; pass++) {
    found = [];
    const sorted = [...candidates].sort((a, b) => b.area - a.area);
    for (const k of sorted) {
      const cx = k.x + k.w / 2, cy = k.y + k.h / 2;
      // Letters on separate tiles are at least a tile apart: anything closer is a fragment or
      // umlaut dot of a letter already found, unless it makes a better tile than that one.
      const near = (t: TileGlyph, x: number, y: number) => Math.hypot(t.cx - x, t.cy - y) < 1.1 * L;
      const hit = inspect(img, cx, cy, L);
      if (!hit) continue;
      const rivals = found.filter((f) => near(f.tile, cx, cy) || near(f.tile, hit.tile.cx, hit.tile.cy));
      if (rivals.some((f) => f.quality >= hit.quality)) continue;
      found = found.filter((f) => !rivals.includes(f));
      found.push(hit);
    }
    const sizes = found.filter((f) => !f.tile.isBar).map((f) => f.size);
    if (sizes.length < 3) break;
    const measured = median(sizes);
    if (Math.abs(measured - L) < 0.1 * L) break;
    L = measured;
  }

  // Letters far smaller or larger than the rest are print on other objects, not tiles.
  const typical = median(found.map((f) => f.size));
  const tiles = found.filter((f) => f.tile.isBar || (f.size > 0.6 * typical && f.size < 1.5 * typical)).map((f) => f.tile);

  // Reading order: group into rows by vertical position, then sort each row by x.
  // Neighbouring rows are at least a tile apart, so tiles within one letter height share a row.
  tiles.sort((a, b) => a.cy - b.cy);
  const rows: TileGlyph[][] = [];
  for (const t of tiles) {
    const row = rows[rows.length - 1];
    const rowY = row ? row.reduce((s, r) => s + r.cy, 0) / row.length : 0;
    if (row && Math.abs(t.cy - rowY) < L) row.push(t);
    else rows.push([t]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.cx - b.cx));
}
