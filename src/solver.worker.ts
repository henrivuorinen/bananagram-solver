/// <reference lib="webworker" />
// Runs the solver off the main thread so the UI stays responsive during a search.
import { buildDictionary, type Dictionary, type Lang } from './solver/dictionary';
import { extend, solve, type SolveResult } from './solver/solver';
import type { Tile } from './solver/board';

/** `dictBase` is the absolute URL of the dict/ folder; relative URLs would resolve against the worker's own path. */
export type SolverRequest = { id: number; lang: Lang; dictBase: string } & (
  | { type: 'load' }
  | { type: 'solve'; letters: string[] }
  | { type: 'extend'; tiles: Tile[]; letters: string[] }
);

export type SolverResponse =
  | { id: number; ok: true; result?: SolveResult; wordCount?: number }
  | { id: number; ok: false; error: string };

const dicts = new Map<Lang, Promise<Dictionary>>();

function dictionary(lang: Lang, base: string): Promise<Dictionary> {
  let d = dicts.get(lang);
  if (!d) {
    d = fetch(new URL(`${lang}.txt`, base))
      .then((res) => {
        if (!res.ok) throw new Error(`Could not load the ${lang} dictionary (${res.status})`);
        return res.text();
      })
      .then((text) => {
        const dict = buildDictionary(lang, text);
        if (dict.words.length < 1000) throw new Error(`The ${lang} dictionary file is missing or broken. Run \`npm run setup\`.`);
        return dict;
      });
    d.catch(() => dicts.delete(lang));
    dicts.set(lang, d);
  }
  return d;
}

self.onmessage = async (e: MessageEvent<SolverRequest>) => {
  const req = e.data;
  try {
    const dict = await dictionary(req.lang, req.dictBase);
    let response: SolverResponse;
    if (req.type === 'load') response = { id: req.id, ok: true, wordCount: dict.words.length };
    else if (req.type === 'solve') response = { id: req.id, ok: true, result: solve(dict, req.letters) };
    else response = { id: req.id, ok: true, result: extend(dict, req.tiles, req.letters) };
    self.postMessage(response);
  } catch (err) {
    self.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies SolverResponse);
  }
};
