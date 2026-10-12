import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildDictionary, normalizeLetters, type Dictionary } from '../src/solver/dictionary';
import { extend, solve, validate } from '../src/solver/solver';
import type { Tile } from '../src/solver/board';

const load = (lang: 'en' | 'fi') =>
  buildDictionary(lang, readFileSync(join(__dirname, '..', 'public', 'dict', `${lang}.txt`), 'utf8'));

const sorted = (xs: string[]) => [...xs].sort().join('');

function expectUsesExactly(tiles: Tile[], letters: string[]) {
  expect(sorted(tiles.map((t) => t.ch))).toBe(sorted(letters));
}

describe('English', () => {
  let en: Dictionary;
  beforeAll(() => {
    en = load('en');
  });

  it('solves a typical 21-tile opening hand', () => {
    const letters = normalizeLetters('AEEIOURSTLNDGHMPCBYKA');
    const res = solve(en, letters, { timeLimitMs: 8000 });
    expect(res.status).toBe('solved');
    expectUsesExactly(res.tiles, letters);
    expect(validate(en, res.tiles).ok).toBe(true);
  });

  it('handles awkward letters like Q, Z, X and J', () => {
    const letters = normalizeLetters('QUIZJAXEROTSNLAEIDMYW');
    const res = solve(en, letters, { timeLimitMs: 8000 });
    expect(validate(en, res.tiles).ok).toBe(true);
    if (res.status !== 'solved') expect(res.suggestDump).toBeTruthy();
    else expectUsesExactly(res.tiles, letters);
  });

  it('reports no-words when nothing can be formed', () => {
    const res = solve(en, normalizeLetters('QQXZ'), { timeLimitMs: 500 });
    expect(res.status).toBe('no-words');
    expect(res.unused).toHaveLength(4);
    expect(['Q', 'X', 'Z']).toContain(res.suggestDump);
  });

  it('returns a valid partial grid and suggests a dump when stuck', () => {
    const letters = normalizeLetters('CATQQ');
    const res = solve(en, letters, { timeLimitMs: 1000 });
    expect(res.status).toBe('partial');
    expect(validate(en, res.tiles).ok).toBe(true);
    expect(res.unused).toContain('Q');
    expect(res.suggestDump).toBe('Q');
  });

  it('extends an existing grid after a peel without rebuilding it', () => {
    const letters = normalizeLetters('AEEIOURSTLNDGHMPCBYKA');
    const first = solve(en, letters, { timeLimitMs: 8000 });
    expect(first.status).toBe('solved');
    const next = extend(en, first.tiles, ['S'], { timeLimitMs: 5000 });
    expect(next.status).toBe('solved');
    expectUsesExactly(next.tiles, [...letters, 'S']);
    expect(validate(en, next.tiles).ok).toBe(true);
    if (next.mode === 'extended') {
      for (const t of first.tiles) expect(next.tiles).toContainEqual(t);
    }
  });

  it('survives a run of peels', () => {
    let letters = normalizeLetters('TRAINSLOVEDHUMPCAKEBI');
    let res = solve(en, letters, { timeLimitMs: 6000 });
    for (const ch of ['E', 'R', 'O', 'N', 'W']) {
      letters = [...letters, ch];
      res = extend(en, res.tiles, [ch], { timeLimitMs: 4000 });
      expect(validate(en, res.tiles).ok).toBe(true);
    }
    expect(res.status).toBe('solved');
    expectUsesExactly(res.tiles, letters);
  });
});

describe('Finnish', () => {
  let fi: Dictionary;
  beforeAll(() => {
    fi = load('fi');
  });

  it('handles Ä and Ö', () => {
    const letters = normalizeLetters('äitiööljyTALOKISSAVENE');
    const res = solve(fi, letters, { timeLimitMs: 8000 });
    expect(validate(fi, res.tiles).ok).toBe(true);
    expect(res.status).toBe('solved');
    expectUsesExactly(res.tiles, letters);
  });
});
