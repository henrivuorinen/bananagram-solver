export type Dir = 'H' | 'V';

export interface Tile {
  r: number;
  c: number;
  ch: string;
}

export interface PlacedWord {
  word: string;
  r: number;
  c: number;
  dir: Dir;
}

const OFFSET = 1 << 10;
const SPAN = 1 << 11;

const key = (r: number, c: number) => (r + OFFSET) * SPAN + (c + OFFSET);

export const step = (dir: Dir): [number, number] => (dir === 'H' ? [0, 1] : [1, 0]);

/** Sparse, unbounded letter grid. Coordinates may be negative. */
export class Board {
  private cells = new Map<number, Tile>();

  static from(tiles: Tile[]): Board {
    const b = new Board();
    for (const t of tiles) b.set(t.r, t.c, t.ch);
    return b;
  }

  get size(): number {
    return this.cells.size;
  }

  get(r: number, c: number): string | undefined {
    return this.cells.get(key(r, c))?.ch;
  }

  set(r: number, c: number, ch: string): void {
    this.cells.set(key(r, c), { r, c, ch });
  }

  delete(r: number, c: number): void {
    this.cells.delete(key(r, c));
  }

  tiles(): Tile[] {
    return [...this.cells.values()];
  }

  /** Letters read along `dir` through (r, c), including the letter `ch` placed at (r, c). */
  runThrough(r: number, c: number, dir: Dir, ch: string): string {
    const [dr, dc] = step(dir);
    let before = '';
    for (let i = 1; ; i++) {
      const x = this.get(r - dr * i, c - dc * i);
      if (!x) break;
      before = x + before;
    }
    let after = '';
    for (let i = 1; ; i++) {
      const x = this.get(r + dr * i, c + dc * i);
      if (!x) break;
      after += x;
    }
    return before + ch + after;
  }

  signature(): string {
    return [...this.cells.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([k, t]) => k + t.ch)
      .join(',');
  }

  bounds() {
    let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
    for (const { r, c } of this.cells.values()) {
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
      minC = Math.min(minC, c);
      maxC = Math.max(maxC, c);
    }
    return { minR, maxR, minC, maxC };
  }

  /** Every run of two or more letters, horizontal and vertical. */
  words(): PlacedWord[] {
    const out: PlacedWord[] = [];
    for (const { r, c } of this.cells.values()) {
      for (const dir of ['H', 'V'] as Dir[]) {
        const [dr, dc] = step(dir);
        if (this.get(r - dr, c - dc)) continue; // not the start of a run
        let word = '';
        for (let i = 0; ; i++) {
          const x = this.get(r + dr * i, c + dc * i);
          if (!x) break;
          word += x;
        }
        if (word.length >= 2) out.push({ word, r, c, dir });
      }
    }
    return out.sort((a, b) => a.r - b.r || a.c - b.c);
  }

  isConnected(): boolean {
    const all = this.tiles();
    if (all.length === 0) return true;
    const seen = new Set<number>([key(all[0].r, all[0].c)]);
    const stack = [all[0]];
    while (stack.length) {
      const { r, c } = stack.pop()!;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = key(r + dr, c + dc);
        const t = this.cells.get(k);
        if (t && !seen.has(k)) {
          seen.add(k);
          stack.push(t);
        }
      }
    }
    return seen.size === all.length;
  }

  /** Text rendering with '.' for empty squares. */
  toRows(): string[] {
    if (this.size === 0) return [];
    const { minR, maxR, minC, maxC } = this.bounds();
    const rows: string[] = [];
    for (let r = minR; r <= maxR; r++) {
      let row = '';
      for (let c = minC; c <= maxC; c++) row += this.get(r, c) ?? '.';
      rows.push(row);
    }
    return rows;
  }
}
