import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createWorker } from 'tesseract.js';
import type { Worker } from 'tesseract.js';
import type { OcrLine } from './slip-match.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The language data sits at server/assets/tessdata when run from source
// (three levels up) and at /app/assets/tessdata in the production image, where
// the code is /app/dist/server/src/sessions/slips/ (five levels up).
const CANDIDATES = [
  path.resolve(HERE, '../../../assets/tessdata'),
  path.resolve(HERE, '../../../../../assets/tessdata'),
];

function hasLanguageData(dir: string): boolean {
  return (
    existsSync(path.join(dir, 'eng.traineddata')) &&
    existsSync(path.join(dir, 'tha.traineddata'))
  );
}

/** Folder holding eng+tha traineddata; the source layout if neither exists. */
export const TESSDATA_DIR: string =
  CANDIDATES.find(hasLanguageData) ?? CANDIDATES[0];

export interface SlipOcrResult {
  text: string;
  lines: OcrLine[];
}

/**
 * One shared tesseract worker (Thai + English). Reads run strictly one at a
 * time; the worker is created on first use and ended with the module.
 */
@Injectable()
export class SlipOcr implements OnModuleDestroy {
  private worker: Worker | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  read(image: Buffer): Promise<SlipOcrResult> {
    const result = this.queue.then(() => this.recognize(image));
    // A failed read must not block the next one in line.
    this.queue = result.catch(() => undefined);
    return result;
  }

  async onModuleDestroy(): Promise<void> {
    // Let a read in flight finish before the worker goes away.
    await this.queue;
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
  }

  private async getWorker(): Promise<Worker> {
    if (this.worker) return this.worker;
    if (!hasLanguageData(TESSDATA_DIR)) {
      throw new Error(
        `Slip OCR language data (eng/tha .traineddata) not found; tried: ${CANDIDATES.join(', ')}`,
      );
    }
    // Assigned only once creation succeeds, so a failure is retried next read.
    this.worker = await createWorker(['tha', 'eng'], 1, {
      langPath: TESSDATA_DIR,
      cacheMethod: 'none',
      gzip: false,
    });
    return this.worker;
  }

  private async recognize(image: Buffer): Promise<SlipOcrResult> {
    const worker = await this.getWorker();
    const { data } = await worker.recognize(image, {}, { blocks: true });
    const lines: OcrLine[] = [];
    for (const block of data.blocks ?? []) {
      for (const paragraph of block.paragraphs) {
        for (const line of paragraph.lines) {
          const text = line.text.trim();
          if (text) lines.push({ text, y0: line.bbox.y0, y1: line.bbox.y1 });
        }
      }
    }
    return { text: data.text, lines };
  }
}
