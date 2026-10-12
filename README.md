# Bananagram Solver

Take a photo of your Bananagrams tiles (or type them in) and get a complete, valid grid that uses all of them.
After each "Peel!", add the new tile and the grid is updated. It changes as little as possible.
Everything runs on your device, so it works with no internet once it has loaded.

- **Dictionaries:** English (ENABLE, 172k words) and Finnish (Kotus *Nykysuomen sanalista*, 101k base-form words), switchable in the app.
- **Photo recognition:** finds each tile at any angle, straightens it and matches the letter's shape. It takes well under a second, on the device.
  Letters it isn't sure about are shown in orange, and tapping a tile offers the likely alternatives.
- **Offline:** a Progressive Web App. Everything (~3 MB, mostly the dictionaries) is cached on first load.

## Running it

```bash
npm install
npm run setup     # one-time: downloads the word lists into public/
npm run dev       # http://localhost:5173
```

Production build (this is the version that works offline):

```bash
npm run build
npm run preview   # http://localhost:4173
```

Tests (solver, plus tile recognition on generated images and a real photo):

```bash
npm test
```

## Using it on a phone

All the work (reading photos, solving) happens in the phone's browser. A computer is only needed to *serve the files*.

### Quick test over Wi-Fi (laptop stays on)

```bash
npm run build
npm run preview -- --host
```

Open the `Network:` address it prints (e.g. `http://192.168.1.145:4173`) on a phone on the same Wi-Fi.
If macOS asks whether to allow incoming connections for Node, choose **Allow**. Stop the server with Ctrl+C.

- Photos and the camera work.
- **Offline mode and installing don't**, because browsers only allow those over HTTPS. The laptop has to keep running.
- The laptop's address can change between networks and restarts, so use the one the command prints.

### Install it for real (no laptop needed)

Host the site over HTTPS, e.g. on GitHub Pages (see [Publishing with GitHub](#publishing-with-github)), Netlify or Cloudflare Pages. Then:

1. Open the URL on your phone.
2. **iPhone:** Safari → Share → *Add to Home Screen*. **Android:** Chrome menu → *Install app*.
3. Open it once while online. From then on it works in airplane mode.

## Publishing with GitHub

The repo includes a workflow (`.github/workflows/deploy.yml`). On every push to `main`, it runs the tests, builds the app and publishes it to GitHub Pages.

### 1. Create the local repository (once)

```bash
cd bananagram-solver
git init -b main
git add .
git status          # check what will be committed
git commit -m "Bananagram solver"
```

Not committed (see `.gitignore`): `node_modules/`, `dist/`, and the downloaded word lists in `public/dict/`.
The workflow re-downloads the word lists on GitHub.

> `tests/photos/` holds an original photo, which is only used for manual testing.
> If you'd rather not publish it, run `git rm -r --cached tests/photos` and add `tests/photos` to `.gitignore` before committing.

### 2. Create the GitHub repository and push

**Option A: GitHub CLI** (`brew install gh`, then `gh auth login` once):

```bash
gh repo create bananagram-solver --public --source=. --push
```

**Option B: the website.**

1. Go to <https://github.com/new>, name it `bananagram-solver`, and leave *all* the "Initialize with README / .gitignore / license" boxes unticked.
2. Create it, then run:

```bash
git remote add origin https://github.com/<your-username>/bananagram-solver.git
git push -u origin main
```

When git asks for a password, use a [personal access token](https://github.com/settings/tokens), not your GitHub password. Logging in once with `gh auth login` also sets this up.

### 3. Turn on GitHub Pages (once)

1. In the repo, open **Settings → Pages**.
2. Under *Build and deployment → Source*, choose **GitHub Actions**.
3. Open the **Actions** tab and re-run the *Deploy* workflow. (Pages wasn't on yet the first time it ran, so that run failed.)

When it's done, the app is at `https://<your-username>.github.io/bananagram-solver/`.

> On a free GitHub account, Pages only works for **public** repositories. If you want a private repo, use Netlify or Cloudflare Pages instead.
> Both can connect to the GitHub repo. Use build command `npm ci && npm run setup && npm run build` and output directory `dist`.

### Updating afterwards

```bash
git add .
git commit -m "Describe the change"
git push
```

Each push redeploys automatically within a minute or two. The installed app on your phone picks up the new version the next time it's opened online.

## How it works

```
photo ──► tiles.ts: find each tile, measure its angle, straighten it
      ──► classify.ts: match the letter against templates in all 4 orientations
      ──► editable tile tray
              │
              ▼
solver.worker.ts (background thread)
  solve():  build a grid from scratch
  extend(): add peeled letters to the existing grid
```

**Solver** (`src/solver/`). Depth-first search over word placements:

- It starts from a strong opening word, then repeatedly attaches dictionary words to letters already in the grid.
- Every new tile is checked against all words it forms crosswise, so the grid is always valid.
- Moves are ranked so that hard letters (Q, Z, X, Ä, Ö…) are played early and the rack keeps a playable mix of vowels and consonants.
- The search is time-limited, with restarts, and remembers dead-end positions.

**Peels** try three things in order, so your grid changes as little as possible:

1. Attach the new letters to the grid as it is.
2. Lift off one small word and re-place its letters together with the new ones.
3. Rebuild the whole grid.

If none of these works, the old grid is kept and the app suggests which letter to **dump**.
If no word can be made at all, it says so and suggests a dump.

Typical speed on a laptop: a 21-tile hand solves in under 0.1 s, 60-tile hands in about 1 s. In simulated full games, peels finish in under 1 s.

**Tile recognition** (`src/ocr/`) runs in under half a second for a typical photo:

1. **Find letter candidates.** An adaptive threshold picks out dark shapes; it copes with shadows and uneven light.
2. **Straighten each tile.** The tile's angle is measured from its straight edges around the letter. The letter is then cut out upright, give or take a quarter turn.
3. **Check it really is a tile.** The tile's edges must appear on (nearly) every side at about the right distance. This rejects shadows, wood grain, tile edges and half-visible tiles at the photo's border. When two candidates claim the same tile, the more convincing one wins.
4. **Read the letter.** The straightened letter is compared with templates of every letter in all four quarter turns.
   - **Which way up:** a hint about how common each letter is breaks ties between shapes that are the same thing turned around: N/Z, M/W, Ä/Å.
   - **Close calls:** when the best match is weak or another letter is close, the tile is marked orange and the runner-up letters are offered when you tap it.

This replaced Tesseract OCR. General-purpose OCR is built for lines of text, not single rotated capitals. On the test photo it read about 31 of 36 tiles; template matching reads every detected tile correctly. It's also 10× faster, and it removed ~20 MB of model files.

Templates are generated from the open-licensed Arimo font by `scripts/make-templates.py` (Python + Pillow). The output (`src/ocr/templates.ts`) is committed, so this is only needed to change the font.

### Project layout

| Path | What |
| --- | --- |
| `src/solver/` | Dictionary, sparse board and search. No browser APIs, so it is reusable in a native app. |
| `src/ocr/tiles.ts` | Finds tiles, measures their angle and cuts out straightened letters (pure pixel code). |
| `src/ocr/classify.ts`, `templates.ts` | Template matching of the straightened letters. |
| `src/ocr/reading.ts` | Picks the letter, and decides when to flag a tile as unsure. |
| `src/ocr/segment.ts` | Low-level pixel helpers (grayscale, adaptive threshold, connected shapes). |
| `src/ocr/ocr.ts` | Browser glue: loads the photo and runs the steps above. |
| `src/solver.worker.ts` | Runs the solver off the main thread. |
| `src/main.ts`, `index.html`, `src/style.css` | UI. |
| `scripts/fetch-assets.mjs` | Downloads the dictionaries (`npm run setup`). |
| `scripts/make-templates.py` | Regenerates the letter templates (only needed to change the font). |
| `tests/fixtures/` | Test images: generated tiles, plus a real photo (three downscaled versions) with an answer key in `tests/tiles.test.ts`. |

## Known limitations / ideas

- Photos work best from straight above, with tiles not touching each other or other objects.
  In the test photo, the only tile missed is one pressed against the dark shadow of a laptop.
- Tiles cut off by the photo's border are skipped on purpose, since their letter may be partly hidden. Type them in if needed.
- Some letters are the same shape turned around (N/Z, M/W). The more common letter for the language is picked and the tile is flagged when it's a close call.
- **Learning from corrections** would be a good next step. When you fix a tile, its shape could be saved as an extra template, so the app adapts to your tile set over time.
- The Finnish list contains base forms only (no inflections such as *talossa*), which matches the usual house rules for word games.
- **App stores:** the same code can be wrapped as a native iOS/Android app with [Capacitor](https://capacitorjs.com/) without rewriting anything, if you want it in the stores rather than installed from the browser.

## Credits

- ENABLE word list: public domain.
- Kotus *Nykysuomen sanalista*: © Kotimaisten kielten keskus, CC BY 4.0.
- Arimo font (letter templates): SIL Open Font License.
