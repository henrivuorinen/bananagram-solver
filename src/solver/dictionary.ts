export type Lang = 'en' | 'fi';

export interface Dictionary {
  lang: Lang;
  /** Uppercase words, length >= 2. */
  words: string[];
  set: Set<string>;
  /** Every letter that occurs in the word list, in a fixed order. */
  alphabet: string[];
  index: Map<string, number>;
  /** Letter counts per word, aligned with `words`. */
  counts: Uint8Array[];
  /** Difficulty per letter: rare letters (Q, Z, Ö...) score higher. */
  weight: Map<string, number>;
}

export function normalizeLetters(input: string): string[] {
  return [...input.toUpperCase()].filter((ch) => /[A-ZÅÄÖ]/.test(ch));
}

export function buildDictionary(lang: Lang, text: string): Dictionary {
  const words = [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((w) => w.trim().toUpperCase())
        .filter((w) => w.length >= 2 && /^[A-ZÅÄÖ]+$/.test(w)),
    ),
  ];

  const freq = new Map<string, number>();
  for (const w of words) for (const ch of w) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  const alphabet = [...freq.keys()].sort();
  const index = new Map(alphabet.map((ch, i) => [ch, i]));

  const counts = words.map((w) => {
    const c = new Uint8Array(alphabet.length);
    for (const ch of w) c[index.get(ch)!]++;
    return c;
  });

  const maxFreq = Math.max(...freq.values());
  const weight = new Map<string, number>();
  for (const [ch, f] of freq) weight.set(ch, 1 + Math.log2(maxFreq / f));

  return { lang, words, set: new Set(words), alphabet, index, counts, weight };
}
