import { Board, type Dir, type PlacedWord, type Tile, step } from './board';
import type { Dictionary } from './dictionary';

export type SolveStatus = 'solved' | 'partial' | 'no-words';

export interface SolveResult {
  status: SolveStatus;
  /**
   * 'fresh' = new grid, 'extended' = previous grid kept as is, 'repaired' = one word of the
   * previous grid was moved, 'rebuilt' = the whole grid was redone.
   */
  mode: 'fresh' | 'extended' | 'repaired' | 'rebuilt';
  tiles: Tile[];
  rows: string[];
  words: PlacedWord[];
  /** Letters the solver could not fit into the grid. */
  unused: string[];
  /** Hardest leftover letter: the best candidate to "dump". */
  suggestDump?: string;
  elapsedMs: number;
}

export interface SolveOptions {
  timeLimitMs?: number;
  now?: () => number;
}

interface Move {
  newTiles: Tile[];
  score: number;
}

interface Ctx {
  dict: Dictionary;
  now: () => number;
  deadline: number;
  /** How many existing grid letters a new word may reuse. */
  maxFromBoard: number;
  branch: number;
  jitter: number;
  failed: Set<string>;
  timedOut: boolean;
  best: Tile[];
  scratch: Int16Array;
}

const DIRS: Dir[] = ['H', 'V'];
const DEFAULT_TIME_MS = 5000;

function rackOf(dict: Dictionary, letters: string[]) {
  const rack = new Int16Array(dict.alphabet.length);
  const unplaceable: string[] = [];
  for (const ch of letters) {
    const i = dict.index.get(ch);
    if (i === undefined) unplaceable.push(ch);
    else rack[i]++;
  }
  return { rack, unplaceable };
}

/** Letters a word needs beyond what the rack holds (they must come from the grid). */
function deficit(counts: Uint8Array, rack: Int16Array, limit: number): number {
  let d = 0;
  for (let i = 0; i < counts.length; i++) {
    const x = counts[i] - rack[i];
    if (x > 0 && (d += x) > limit) return d;
  }
  return d;
}

function filterCandidates(ctx: Ctx, from: number[], rack: Int16Array, rackSize: number): number[] {
  const { dict, maxFromBoard } = ctx;
  const out: number[] = [];
  for (const wi of from) {
    const w = dict.words[wi];
    if (w.length > rackSize + maxFromBoard) continue;
    const d = deficit(dict.counts[wi], rack, maxFromBoard);
    if (d <= maxFromBoard && d < w.length) out.push(wi);
  }
  return out;
}

const VOWELS = new Set([...'AEIOUYÅÄÖ']);

/**
 * Rare letters are worth playing early; so is keeping a playable mix of vowels
 * and consonants on the rack (a rack of only E's and A's is a dead end).
 */
function scoreTiles(ctx: Ctx, tiles: Tile[], rackVowels: number, rackSize: number): number {
  let s = 0;
  let vowelsUsed = 0;
  for (const t of tiles) {
    s += ctx.dict.weight.get(t.ch)! + 0.3;
    if (VOWELS.has(t.ch)) vowelsUsed++;
  }
  const left = rackSize - tiles.length;
  const imbalance = Math.abs(rackVowels - vowelsUsed - 0.4 * left);
  s -= 0.8 * imbalance;
  return s + (ctx.jitter ? Math.random() * ctx.jitter : 0);
}

/** Checks a word placement against the grid; returns the new tiles it lays, or null if illegal. */
function tryPlace(ctx: Ctx, board: Board, rack: Int16Array, w: string, r0: number, c0: number, dir: Dir): Tile[] | null {
  const [dr, dc] = step(dir);
  if (board.get(r0 - dr, c0 - dc) || board.get(r0 + dr * w.length, c0 + dc * w.length)) return null;

  const { dict, scratch } = ctx;
  scratch.fill(0);
  const perp: Dir = dir === 'H' ? 'V' : 'H';
  const newTiles: Tile[] = [];
  let fromBoard = 0;

  for (let j = 0; j < w.length; j++) {
    const r = r0 + dr * j;
    const c = c0 + dc * j;
    const existing = board.get(r, c);
    if (existing) {
      if (existing !== w[j]) return null;
      fromBoard++;
      continue;
    }
    const li = dict.index.get(w[j])!;
    if (++scratch[li] > rack[li]) return null;
    const cross = board.runThrough(r, c, perp, w[j]);
    if (cross.length > 1 && !dict.set.has(cross)) return null;
    newTiles.push({ r, c, ch: w[j] });
  }

  if (fromBoard === 0 || newTiles.length === 0) return null;
  return newTiles;
}

function generateMoves(ctx: Ctx, board: Board, rack: Int16Array, rackSize: number, candidates: number[]): Move[] {
  // A tile can anchor a new word only in a direction where it is not already part of a word.
  const anchorsByLetter = new Map<string, { t: Tile; dir: Dir }[]>();
  for (const t of board.tiles()) {
    for (const dir of DIRS) {
      const [dr, dc] = step(dir);
      if (board.get(t.r - dr, t.c - dc) || board.get(t.r + dr, t.c + dc)) continue;
      const list = anchorsByLetter.get(t.ch);
      if (list) list.push({ t, dir });
      else anchorsByLetter.set(t.ch, [{ t, dir }]);
    }
  }

  let rackVowels = 0;
  for (const [ch, i] of ctx.dict.index) if (VOWELS.has(ch)) rackVowels += rack[i];

  const seen = new Set<string>();
  const moves: Move[] = [];
  for (const wi of candidates) {
    const w = ctx.dict.words[wi];
    for (let i = 0; i < w.length; i++) {
      const anchors = anchorsByLetter.get(w[i]);
      if (!anchors) continue;
      for (const { t, dir } of anchors) {
        const [dr, dc] = step(dir);
        const r0 = t.r - dr * i;
        const c0 = t.c - dc * i;
        const newTiles = tryPlace(ctx, board, rack, w, r0, c0, dir);
        if (!newTiles) continue;
        // A word crossing two anchors in one line is found twice.
        const k = `${wi}:${dir}:${r0}:${c0}`;
        if (seen.has(k)) continue;
        seen.add(k);
        moves.push({ newTiles, score: scoreTiles(ctx, newTiles, rackVowels, rackSize) });
      }
    }
  }
  return moves.sort((a, b) => b.score - a.score);
}

function search(ctx: Ctx, board: Board, rack: Int16Array, remaining: number, candidates: number[]): boolean {
  if (board.size > ctx.best.length) ctx.best = board.tiles();
  if (remaining === 0) return true;
  if (ctx.now() > ctx.deadline) {
    ctx.timedOut = true;
    return false;
  }
  const sig = board.signature();
  if (ctx.failed.has(sig)) return false;

  // The rack only shrinks deeper in the tree, so children can reuse this narrower list.
  const narrowed = filterCandidates(ctx, candidates, rack, remaining);
  const moves = generateMoves(ctx, board, rack, remaining, narrowed).slice(0, ctx.branch);

  for (const m of moves) {
    for (const t of m.newTiles) {
      board.set(t.r, t.c, t.ch);
      rack[ctx.dict.index.get(t.ch)!]--;
    }
    if (search(ctx, board, rack, remaining - m.newTiles.length, narrowed)) return true;
    for (const t of m.newTiles) {
      board.delete(t.r, t.c);
      rack[ctx.dict.index.get(t.ch)!]++;
    }
    if (ctx.timedOut) return false;
  }
  ctx.failed.add(sig);
  return false;
}

function makeCtx(dict: Dictionary, opts: SolveOptions, maxFromBoard: number): Ctx {
  return {
    dict,
    now: opts.now ?? (() => performance.now()),
    deadline: Infinity,
    maxFromBoard,
    branch: 6,
    jitter: 0,
    failed: new Set(),
    timedOut: false,
    best: [],
    scratch: new Int16Array(dict.alphabet.length),
  };
}

function leftovers(dict: Dictionary, letters: string[], tiles: Tile[]): string[] {
  const pool = [...letters];
  for (const t of tiles) {
    const i = pool.indexOf(t.ch);
    if (i >= 0) pool.splice(i, 1);
  }
  return pool;
}

function hardest(dict: Dictionary, letters: string[]): string | undefined {
  // Letters missing from the dictionary entirely are the hardest of all.
  return [...letters].sort((a, b) => (dict.weight.get(b) ?? 99) - (dict.weight.get(a) ?? 99))[0];
}

function finish(
  dict: Dictionary,
  letters: string[],
  tiles: Tile[],
  start: number,
  now: () => number,
  mode: SolveResult['mode'],
): SolveResult {
  const board = Board.from(tiles);
  const unused = leftovers(dict, letters, tiles);
  const status: SolveStatus = unused.length === 0 ? 'solved' : tiles.length === 0 ? 'no-words' : 'partial';
  return {
    status,
    mode,
    tiles,
    rows: board.toRows(),
    words: board.words(),
    unused,
    suggestDump: unused.length ? hardest(dict, unused) : undefined,
    elapsedMs: Math.round(now() - start),
  };
}

/** Builds a complete grid from scratch using every letter. */
export function solve(dict: Dictionary, input: string[], opts: SolveOptions = {}): SolveResult {
  const ctx = makeCtx(dict, opts, 3);
  const start = ctx.now();
  const end = start + (opts.timeLimitMs ?? DEFAULT_TIME_MS);
  const letters = [...input];
  const { rack, unplaceable } = rackOf(dict, letters);
  const placeable = letters.length - unplaceable.length;

  const all = dict.words.map((_, i) => i);
  const candidates = filterCandidates(ctx, all, rack, placeable);

  // Opening words must be fully formable from the rack. Rare letters first, then length.
  const openers = candidates
    .filter((wi) => deficit(dict.counts[wi], rack, 0) === 0)
    .map((wi) => ({ wi, score: [...dict.words[wi]].reduce((s, ch) => s + dict.weight.get(ch)! + 0.3, 0) }))
    .sort((a, b) => b.score - a.score)
    .map((o) => o.wi);

  if (openers.length === 0) return finish(dict, letters, [], start, ctx.now, 'fresh');

  const OPENERS_PER_ROUND = 8;
  const slice = Math.max(250, (end - start) / 6);

  for (let round = 0; ctx.now() < end && round < 12; round++) {
    ctx.branch = 6 + round * 4;
    ctx.jitter = round * 0.6;
    ctx.failed.clear();
    let anyTimeout = false;
    const offset = (round * 3) % Math.max(1, openers.length);
    const batch = [...openers.slice(offset), ...openers.slice(0, offset)].slice(0, OPENERS_PER_ROUND);

    for (const wi of batch) {
      if (ctx.now() >= end) break;
      const w = dict.words[wi];
      const board = new Board();
      for (let j = 0; j < w.length; j++) {
        board.set(0, j, w[j]);
        rack[dict.index.get(w[j])!]--;
      }
      ctx.deadline = Math.min(end, ctx.now() + slice);
      ctx.timedOut = false;
      const ok = search(ctx, board, rack, placeable - w.length, candidates);
      if (ok && unplaceable.length === 0) return finish(dict, letters, board.tiles(), start, ctx.now, 'fresh');
      if (ok) break; // everything placeable is placed; the rest can never fit
      for (const ch of w) rack[dict.index.get(ch)!]++;
      anyTimeout ||= ctx.timedOut;
    }
    // Every opener was searched exhaustively at this width and the whole list fit in one batch.
    if (!anyTimeout && openers.length <= OPENERS_PER_ROUND && ctx.branch >= 30) break;
  }
  return finish(dict, letters, ctx.best, start, ctx.now, 'fresh');
}

/** Tries to place every letter of `letters` onto a copy of the grid. Returns the new grid, or null. */
function attach(dict: Dictionary, base: Tile[], letters: string[], deadline: number, opts: SolveOptions): Tile[] | null {
  const ctx = makeCtx(dict, opts, 8);
  ctx.deadline = deadline;
  const { rack, unplaceable } = rackOf(dict, letters);
  if (unplaceable.length) return null;
  const board = Board.from(base);
  const candidates = filterCandidates(ctx, dict.words.map((_, i) => i), rack, letters.length);
  for (const branch of [8, 20]) {
    ctx.branch = branch;
    ctx.failed.clear();
    ctx.timedOut = false;
    if (search(ctx, board, rack, letters.length, candidates)) return board.tiles();
    if (ctx.timedOut) break;
  }
  return null;
}

/**
 * Words that can be lifted off the grid while leaving it valid and connected,
 * smallest first. Only tiles that belong to no other word are removed.
 */
function removableWords(dict: Dictionary, board: Board): { removed: Tile[]; rest: Tile[] }[] {
  const out: { removed: Tile[]; rest: Tile[] }[] = [];
  for (const w of board.words()) {
    const [dr, dc] = step(w.dir);
    const perp: Dir = w.dir === 'H' ? 'V' : 'H';
    const removed: Tile[] = [];
    for (let j = 0; j < w.word.length; j++) {
      const r = w.r + dr * j;
      const c = w.c + dc * j;
      if (board.runThrough(r, c, perp, w.word[j]).length === 1) removed.push({ r, c, ch: w.word[j] });
    }
    if (removed.length === 0 || removed.length === board.size) continue;
    const gone = new Set(removed.map((t) => `${t.r},${t.c}`));
    const rest = board.tiles().filter((t) => !gone.has(`${t.r},${t.c}`));
    if (validate(dict, rest).ok) out.push({ removed, rest });
  }
  return out.sort((a, b) => a.removed.length - b.removed.length);
}

/**
 * Adds newly drawn letters ("Peel!") to an existing grid, disturbing it as little as possible:
 *   1. attach the new letters to the grid as it is;
 *   2. lift off one small word and re-place its letters together with the new ones;
 *   3. rebuild the whole grid.
 * If all of that fails, the old grid is kept and the new letters are reported as unused.
 */
export function extend(dict: Dictionary, tiles: Tile[], newLetters: string[], opts: SolveOptions = {}): SolveResult {
  const now = opts.now ?? (() => performance.now());
  const total = opts.timeLimitMs ?? DEFAULT_TIME_MS;
  const start = now();
  const allLetters = [...tiles.map((t) => t.ch), ...newLetters];
  const done = (t: Tile[], mode: SolveResult['mode']) => finish(dict, allLetters, t, start, now, mode);

  if (tiles.length > 0 && validate(dict, tiles).ok) {
    const attached = attach(dict, tiles, newLetters, start + total * 0.25, opts);
    if (attached) return done(attached, 'extended');

    const repairEnd = start + total * 0.65;
    for (const { removed, rest } of removableWords(dict, Board.from(tiles)).slice(0, 25)) {
      if (now() >= repairEnd) break;
      const letters = [...newLetters, ...removed.map((t) => t.ch)];
      const deadline = Math.min(repairEnd, now() + Math.max(100, total * 0.08));
      const repaired = attach(dict, rest, letters, deadline, opts);
      if (repaired) return done(repaired, 'repaired');
    }
  }

  const remaining = Math.max(500, total - (now() - start));
  const rebuilt: SolveResult = { ...solve(dict, allLetters, { ...opts, timeLimitMs: remaining }), mode: 'rebuilt' };
  const kept = done(tiles, 'extended');
  // Prefer keeping the player's grid unless the rebuild genuinely places more letters.
  const best = tiles.length > 0 && kept.unused.length <= rebuilt.unused.length ? kept : rebuilt;
  return { ...best, elapsedMs: Math.round(now() - start) };
}

/** Verifies a grid: connected, and every run of 2+ letters is a dictionary word. */
export function validate(dict: Dictionary, tiles: Tile[]): { ok: boolean; invalid: string[] } {
  const board = Board.from(tiles);
  const invalid = board.words().filter((w) => !dict.set.has(w.word)).map((w) => w.word);
  return { ok: invalid.length === 0 && board.isConnected(), invalid };
}
