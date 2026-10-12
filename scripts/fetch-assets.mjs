// Downloads the word lists into public/ so the app can run fully offline.
// Run once after `npm install`: `npm run setup`.
import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');

const DICTS = {
  en: {
    url: 'https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt',
    // ENABLE word list (public domain): one lowercase word per line.
    parse: (text) => text.split(/\r?\n/),
  },
  fi: {
    url: 'https://kaino.kotus.fi/lataa/nykysuomensanalista2024.txt',
    // Kotus Nykysuomen sanalista (CC BY 4.0): TSV, first column is the headword.
    parse: (text) => text.split(/\r?\n/).slice(1).map((line) => line.split('\t')[0]),
  },
};

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return res;
}

async function fetchDictionaries() {
  await mkdir(join(pub, 'dict'), { recursive: true });
  for (const [lang, { url, parse }] of Object.entries(DICTS)) {
    const out = join(pub, 'dict', `${lang}.txt`);
    if (await exists(out)) {
      console.log(`dict/${lang}.txt already present`);
      continue;
    }
    const text = await (await download(url)).text();
    // Lowercase-only entries skip proper nouns, abbreviations and hyphenated compounds.
    const words = new Set(
      parse(text)
        .map((w) => (w ?? '').trim())
        .filter((w) => w.length >= 2 && /^[a-zåäö]+$/.test(w))
        .map((w) => w.toUpperCase()),
    );
    await writeFile(out, [...words].sort().join('\n'));
    console.log(`dict/${lang}.txt: ${words.size} words`);
  }
}

await fetchDictionaries();
