import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { normalizeLetters, type Lang } from './solver/dictionary';
import type { Tile } from './solver/board';
import type { SolveResult } from './solver/solver';
import type { SolverRequest, SolverResponse } from './solver.worker';
import { recognizeTiles, type DetectedTile } from './ocr/ocr';

interface HandTile {
  ch: string;
  unsure?: boolean;
  /** Other letters the photo could have shown, most likely first. */
  alternatives?: string[];
  /** Index into state.detections when the tile came from the current photo. */
  detection?: number;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const els = {
  lang: $<HTMLSelectElement>('lang'),
  photo: $<HTMLInputElement>('photo'),
  ocrStatus: $('ocr-status'),
  preview: $('preview'),
  typeForm: $<HTMLFormElement>('type-form'),
  typeInput: $<HTMLInputElement>('type-input'),
  count: $('count'),
  clear: $('clear'),
  tray: $('tray'),
  editor: $('tile-editor'),
  solve: $<HTMLButtonElement>('solve'),
  resultCard: $('result-card'),
  message: $('message'),
  grid: $('grid'),
  words: $('words'),
  peelCard: $('peel-card'),
  peelForm: $<HTMLFormElement>('peel-form'),
  peelInput: $<HTMLInputElement>('peel-input'),
  dumpBox: $('dump-box'),
  offline: $('offline'),
  dictInfo: $('dict-info'),
};

const state = {
  lang: 'en' as Lang,
  hand: [] as HandTile[],
  result: null as SolveResult | null,
  /** The tray changed since the grid was built, so the next action must re-solve. */
  stale: false,
  /** Grid squares that existed before the last update, to highlight what changed. */
  before: new Set<string>(),
  busy: false,
  /** Tray tile being edited. */
  selected: null as number | null,
  /** The last photo, unmarked, and what was found in it. */
  photo: null as HTMLCanvasElement | null,
  detections: [] as DetectedTile[],
};

// ---------- Solver worker ----------

type WithoutId<T> = T extends unknown ? Omit<T, 'id' | 'dictBase'> : never;
const dictBase = new URL('dict/', document.baseURI).href;
const worker = new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' });
const pending = new Map<number, (r: SolverResponse) => void>();
let nextId = 1;
worker.onmessage = (e: MessageEvent<SolverResponse>) => {
  pending.get(e.data.id)?.(e.data);
  pending.delete(e.data.id);
};

function callSolver(req: WithoutId<SolverRequest>): Promise<Extract<SolverResponse, { ok: true }>> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, (r) => (r.ok ? resolve(r) : reject(new Error(r.error))));
    worker.postMessage({ ...req, id, dictBase } as SolverRequest);
  });
}

// ---------- Rendering ----------

const key = (t: { r: number; c: number }) => `${t.r},${t.c}`;

function tileEl(ch: string, cls = '', tag: 'span' | 'button' = 'span'): HTMLElement {
  const el = document.createElement(tag);
  el.className = `tile ${cls}`.trim();
  el.textContent = ch;
  if (tag === 'button') (el as HTMLButtonElement).type = 'button';
  return el;
}

function renderTray() {
  if (state.selected !== null && state.selected >= state.hand.length) state.selected = null;
  els.tray.replaceChildren(
    ...state.hand.map((t, i) => {
      const cls = [t.unsure ? 'unsure' : '', i === state.selected ? 'selected' : ''].join(' ');
      const b = tileEl(t.ch, cls, 'button');
      b.setAttribute('aria-label', `Edit ${t.ch}`);
      b.setAttribute('aria-pressed', String(i === state.selected));
      b.onclick = () => select(state.selected === i ? null : i);
      return b;
    }),
  );
  renderEditor();
  const n = state.hand.length;
  els.count.textContent = `${n} tile${n === 1 ? '' : 's'}`;
  els.solve.disabled = state.busy || n < 2;
  els.solve.textContent = state.busy ? 'Solving…' : state.result && !state.stale ? 'Solve again from scratch' : 'Solve';
}

function select(i: number | null) {
  state.selected = i;
  renderTray();
  drawPreview();
}

function setLetter(i: number, ch: string) {
  const t = state.hand[i];
  t.ch = ch;
  t.unsure = false;
  if (t.detection !== undefined) {
    state.detections[t.detection] = { ...state.detections[t.detection], letter: ch, unsure: false };
  }
  markStale();
  select(null);
}

function removeTile(i: number) {
  state.hand.splice(i, 1);
  markStale();
  select(null);
}

/** Inline editor for the selected tray tile: likely alternatives, any other letter, or remove. */
function renderEditor() {
  const i = state.selected;
  if (i === null) {
    els.editor.hidden = true;
    return;
  }
  const t = state.hand[i];
  const label = document.createElement('span');
  label.textContent = `Change ${t.ch} to`;

  const alts = (t.alternatives ?? []).filter((ch) => ch !== t.ch).slice(0, 4).map((ch) => {
    const b = tileEl(ch, '', 'button');
    b.setAttribute('aria-label', `Change to ${ch}`);
    b.onclick = () => setLetter(i, ch);
    return b;
  });

  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 1;
  input.placeholder = alts.length ? 'other' : 'letter';
  input.setAttribute('aria-label', 'Type the correct letter');
  input.autocapitalize = 'characters';
  input.oninput = () => {
    const [ch] = normalizeLetters(input.value);
    if (ch) setLetter(i, ch);
    else input.value = '';
  };

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn secondary';
  remove.textContent = 'Remove';
  remove.onclick = () => removeTile(i);

  els.editor.replaceChildren(label, ...alts, input, remove);
  els.editor.hidden = false;
}

function renderGrid(result: SolveResult) {
  const tiles = new Map(result.tiles.map((t) => [key(t), t]));
  const rows = result.rows;
  const cols = rows[0]?.length ?? 0;
  if (!rows.length) {
    els.grid.replaceChildren();
    return;
  }
  const minR = Math.min(...result.tiles.map((t) => t.r));
  const minC = Math.min(...result.tiles.map((t) => t.c));
  const avail = els.grid.parentElement!.clientWidth || 320;
  const cell = Math.max(18, Math.min(36, Math.floor((avail - (cols - 1) * 2) / cols)));
  els.grid.style.setProperty('--cell', `${cell}px`);
  els.grid.style.gridTemplateColumns = `repeat(${cols}, ${cell}px)`;

  const cells: HTMLElement[] = [];
  rows.forEach((row, r) => {
    [...row].forEach((_, c) => {
      const t = tiles.get(key({ r: r + minR, c: c + minC }));
      if (!t) {
        const gap = document.createElement('span');
        gap.className = 'gap';
        cells.push(gap);
        return;
      }
      const isNew = state.before.size > 0 && !state.before.has(key(t));
      cells.push(tileEl(t.ch, isNew ? 'new' : ''));
    });
  });
  els.grid.replaceChildren(...cells);
  els.words.replaceChildren(
    ...result.words.map((w) => {
      const li = document.createElement('li');
      li.textContent = w.word;
      return li;
    }),
  );
}

function setMessage(text: string, kind: 'ok' | 'warn' | 'err') {
  els.message.className = `message ${kind}`;
  els.message.textContent = text;
}

function describe(result: SolveResult) {
  const total = result.tiles.length + result.unused.length;
  const secs = (result.elapsedMs / 1000).toFixed(1);
  if (result.status === 'solved') {
    const how = {
      fresh: `All ${total} tiles used in ${result.words.length} words.`,
      extended: 'Added to your grid. New tiles are green.',
      repaired: 'Moved one word to make room. Changed tiles are green.',
      rebuilt: 'Rebuilt the grid to fit everything.',
    }[result.mode];
    setMessage(`✓ ${how} (${secs} s)`, 'ok');
  } else if (result.status === 'partial') {
    setMessage(
      `Used ${result.tiles.length} of ${total} tiles. Couldn't fit: ${result.unused.join(' ')}. ` +
        `Consider dumping ${result.suggestDump}.`,
      'warn',
    );
  } else {
    setMessage(
      result.unused.length < 2
        ? 'You need at least two tiles to make a word.'
        : `No word can be made from these letters. Dump ${result.suggestDump} and take 3 new tiles.`,
      'err',
    );
  }
}

function renderDump(result: SolveResult) {
  if (!result.unused.length) {
    els.dumpBox.hidden = true;
    return;
  }
  els.dumpBox.hidden = false;
  const intro = document.createElement('div');
  intro.textContent = 'Letters left over. Tap one to dump it, then type the 3 tiles you took:';
  const tiles = document.createElement('div');
  tiles.className = 'tiles';
  const order = [...result.unused].sort((a, b) => Number(b === result.suggestDump) - Number(a === result.suggestDump));
  for (const ch of new Set(order)) {
    const b = tileEl(ch, ch === result.suggestDump ? 'unsure' : '', 'button');
    b.title = `Dump ${ch}`;
    b.setAttribute('aria-label', `Dump ${ch}`);
    b.onclick = () => dump(ch);
    tiles.append(b);
  }
  els.dumpBox.replaceChildren(intro, tiles);
}

function showResult(result: SolveResult) {
  state.result = result;
  state.stale = false;
  els.resultCard.hidden = false;
  els.peelCard.hidden = false;
  describe(result);
  renderGrid(result);
  renderDump(result);
  renderTray();
}

function markStale() {
  if (state.result) state.stale = true;
}

// ---------- Actions ----------

function addLetters(letters: string[], unsure = false) {
  state.hand.push(...letters.map((ch) => ({ ch, unsure })));
  markStale();
  renderTray();
}

async function run(task: () => Promise<void>) {
  if (state.busy) return;
  state.busy = true;
  renderTray();
  try {
    await task();
  } catch (err) {
    els.resultCard.hidden = false;
    setMessage(`Something went wrong: ${err instanceof Error ? err.message : err}`, 'err');
  } finally {
    state.busy = false;
    renderTray();
  }
}

function solveFresh() {
  return run(async () => {
    setMessage('Solving…', 'ok');
    const { result } = await callSolver({ type: 'solve', lang: state.lang, letters: state.hand.map((t) => t.ch) });
    state.before = new Set();
    showResult(result!);
  });
}

function peel(letters: string[]) {
  if (!letters.length) return;
  state.hand.push(...letters.map((ch) => ({ ch })));
  const prev = state.result;
  if (!prev || prev.status === 'no-words' || state.stale) {
    renderTray();
    return solveFresh();
  }
  return run(async () => {
    const { result } = await callSolver({
      type: 'extend',
      lang: state.lang,
      tiles: prev.tiles,
      letters: [...prev.unused, ...letters],
    });
    state.before = new Set(prev.tiles.map(key));
    showResult(result!);
  });
}

function dump(ch: string) {
  const r = state.result;
  if (!r) return;
  const i = state.hand.findIndex((t) => t.ch === ch);
  if (i >= 0) state.hand.splice(i, 1);
  const unused = [...r.unused];
  unused.splice(unused.indexOf(ch), 1);
  state.result = { ...r, unused, suggestDump: undefined, status: unused.length ? 'partial' : 'solved' };
  renderDump(state.result);
  renderTray();
  setMessage(`Dumped ${ch}. Type the 3 tiles you took below.`, 'warn');
  els.peelInput.placeholder = 'The 3 new tiles';
  els.peelInput.focus();
}

function drawPreview() {
  if (!state.photo) return;
  const canvas = document.createElement('canvas');
  canvas.width = state.photo.width;
  canvas.height = state.photo.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(state.photo, 0, 0);
  const selected = state.selected !== null ? state.hand[state.selected]?.detection : undefined;
  const lw = Math.max(2, canvas.width / 400);
  ctx.lineWidth = lw;
  ctx.font = `bold ${Math.max(14, canvas.width / 45)}px system-ui, sans-serif`;
  ctx.textBaseline = 'bottom';
  state.detections.forEach((t, i) => {
    const color = i === selected ? '#2f6fde' : t.unsure ? '#f39c34' : '#2fa84f';
    const { x, y, w, h } = t.box;
    const pad = i === selected ? lw * 3 : lw;
    ctx.lineWidth = i === selected ? lw * 2 : lw;
    ctx.strokeStyle = color;
    ctx.strokeRect(x - pad, y - pad, w + 2 * pad, h + 2 * pad);
    ctx.fillStyle = color;
    ctx.fillText(t.letter, x, y - pad - lw);
  });
  els.preview.replaceChildren(canvas);
  els.preview.hidden = false;
}

async function handlePhoto(file: File) {
  els.ocrStatus.textContent = 'Reading tiles…';
  try {
    const { tiles, canvas } = await recognizeTiles(file, state.lang);
    // Tiles from an earlier photo lose their link to it.
    for (const t of state.hand) delete t.detection;
    state.photo = canvas;
    state.detections = tiles;
    state.selected = null;
    drawPreview();
    if (!tiles.length) {
      els.ocrStatus.textContent =
        'No tiles found. Try a closer, evenly lit photo from straight above, or type the letters.';
      return;
    }
    const unsure = tiles.filter((t) => t.unsure).length;
    els.ocrStatus.textContent =
      `Found ${tiles.length} tiles.` + (unsure ? ` ${unsure} ${unsure === 1 ? 'was' : 'were'} hard to read (orange), so check ${unsure === 1 ? 'it' : 'them'}.` : '');
    state.hand.push(
      ...tiles.map((t, i) => ({ ch: t.letter, unsure: t.unsure, alternatives: t.alternatives, detection: i })),
    );
    markStale();
    renderTray();
  } catch (err) {
    els.ocrStatus.textContent = `Could not read the photo: ${err instanceof Error ? err.message : err}`;
  }
}

function setLang(lang: Lang) {
  state.lang = lang;
  els.lang.value = lang;
  try {
    localStorage.setItem('lang', lang);
  } catch {
    /* storage unavailable: language just won't be remembered */
  }
  markStale();
  renderTray();
  const name = lang === 'fi' ? 'Suomi' : 'English';
  els.dictInfo.textContent = `Loading ${name} dictionary…`;
  callSolver({ type: 'load', lang })
    .then(({ wordCount }) => {
      if (state.lang === lang) els.dictInfo.textContent = `${name}: ${wordCount!.toLocaleString()} words`;
    })
    .catch((err) => (els.dictInfo.textContent = err.message));
}

// ---------- Wiring ----------

els.lang.onchange = () => setLang(els.lang.value as Lang);
els.photo.onchange = () => {
  const file = els.photo.files?.[0];
  if (file) handlePhoto(file);
  els.photo.value = '';
};
els.typeForm.onsubmit = (e) => {
  e.preventDefault();
  addLetters(normalizeLetters(els.typeInput.value));
  els.typeInput.value = '';
};
els.clear.onclick = () => {
  state.hand = [];
  state.result = null;
  state.stale = false;
  els.preview.hidden = true;
  state.photo = null;
  state.detections = [];
  state.selected = null;
  els.resultCard.hidden = true;
  els.peelCard.hidden = true;
  els.ocrStatus.textContent = '';
  renderTray();
};
els.solve.onclick = () => solveFresh();
els.peelForm.onsubmit = (e) => {
  e.preventDefault();
  const letters = normalizeLetters(els.peelInput.value);
  els.peelInput.value = '';
  els.peelInput.placeholder = 'New letter(s)';
  peel(letters);
};
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => state.result && renderGrid(state.result), 150);
});

let savedLang: string | null = null;
try {
  savedLang = localStorage.getItem('lang');
} catch {
  /* ignore */
}
setLang(savedLang === 'fi' ? 'fi' : 'en');
renderTray();

if (import.meta.env.DEV) {
  els.offline.textContent = 'Dev mode (offline caching is enabled in the production build)';
} else {
  els.offline.textContent = navigator.serviceWorker?.controller ? 'Works offline ✓' : 'Preparing offline mode…';
  registerSW({
    immediate: true,
    onOfflineReady: () => (els.offline.textContent = 'Ready to work offline ✓'),
  });
}
