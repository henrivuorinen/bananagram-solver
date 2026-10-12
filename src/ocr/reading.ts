import type { Lang } from '../solver/dictionary';

/**
 * How common each letter is among the tiles, used to break ties between readings that
 * are the same shape turned around (N/Z, M/W). English: the 144-tile Bananagrams set.
 * Finnish: letter frequency in Finnish text, in percent.
 */
const LETTER_FREQ: Record<Lang, Record<string, number>> = {
  en: {
    A: 13, B: 3, C: 3, D: 6, E: 18, F: 3, G: 4, H: 3, I: 12, J: 2, K: 2, L: 5, M: 3,
    N: 8, O: 11, P: 3, Q: 2, R: 9, S: 6, T: 9, U: 6, V: 3, W: 3, X: 2, Y: 3, Z: 2,
  },
  fi: {
    A: 12.2, B: 0.28, C: 0.28, D: 1.04, E: 7.97, F: 0.19, G: 0.39, H: 1.85, I: 10.8, J: 2.04,
    K: 4.97, L: 5.76, M: 3.2, N: 8.83, O: 5.6, P: 1.84, Q: 0.01, R: 2.87, S: 7.86, T: 8.75,
    U: 5.0, V: 2.25, W: 0.09, X: 0.03, Y: 1.75, Z: 0.05, Å: 0.01, Ä: 3.6, Ö: 0.44,
  },
};

export interface Reading {
  letter: string;
  /** Match score, 0–100 (100 = identical shape). */
  confidence: number;
}

export interface Choice {
  letter: string;
  confidence: number;
  /** Worth a second look: low confidence, or another letter came close. */
  unsure: boolean;
  /** Other plausible letters, most likely first. */
  alternatives: string[];
}

const PRIOR_WEIGHT = 3;
const CLOSE_CALL = 4;
const LOW_CONFIDENCE = 80;

/** Picks the most likely letter from the readings of one tile in its four orientations. */
export function chooseReading(readings: Reading[], lang: Lang): Choice | null {
  const freq = LETTER_FREQ[lang];
  const top = Math.max(...Object.values(freq));
  const best = new Map<string, number>();
  for (const r of readings) {
    const f = freq[r.letter];
    if (!f) continue;
    const score = r.confidence + PRIOR_WEIGHT * Math.log10(f / top);
    if (score > (best.get(r.letter) ?? -Infinity)) best.set(r.letter, score);
  }
  const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;

  const [letter, score] = ranked[0];
  const confidence = Math.max(...readings.filter((r) => r.letter === letter).map((r) => r.confidence));
  const alternatives = ranked.slice(1).map(([l]) => l);
  const unsure = confidence < LOW_CONFIDENCE || (ranked.length > 1 && score - ranked[1][1] < CLOSE_CALL);
  return { letter, confidence, unsure, alternatives };
}
