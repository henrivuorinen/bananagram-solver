import type { Lang } from '../solver/dictionary';
import { readTile } from './classify';
import { chooseReading } from './reading';
import { toGray, type Box } from './segment';
import { findTiles } from './tiles';

export interface DetectedTile {
  box: Box;
  letter: string;
  /** Match score, 0–100. */
  confidence: number;
  /** Worth a second look: a weak match, or another letter came close. */
  unsure: boolean;
  /** Other plausible letters, most likely first. */
  alternatives: string[];
}

export interface OcrResult {
  tiles: DetectedTile[];
  /** The downscaled image the boxes refer to. */
  canvas: HTMLCanvasElement;
}

const MAX_SIDE = 1400;

async function loadImage(file: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d')!;
  // The default (fast) downscaling leaves jagged letter edges that hurt recognition.
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

/** Finds the tiles in a photo and reads their letters, whichever way each tile is turned. */
export async function recognizeTiles(file: Blob, lang: Lang): Promise<OcrResult> {
  const canvas = await loadImage(file);
  const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
  const tiles: DetectedTile[] = [];
  for (const tile of findTiles(toGray(data, canvas.width, canvas.height))) {
    const choice = chooseReading(readTile(tile, lang), lang);
    if (choice) tiles.push({ box: tile.box, ...choice });
  }
  return { tiles, canvas };
}
