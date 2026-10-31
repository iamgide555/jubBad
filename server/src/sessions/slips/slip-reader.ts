import { Injectable } from '@nestjs/common';
import { SlipOcr } from './slip-ocr.js';
import type { SlipOcrResult } from './slip-ocr.js';
import { decodeSlipQr, imageDimensions } from './slip-qr.js';
import type { SlipQr } from './slip-qr.js';

export type SlipRead =
  | { kind: 'not-slip' }
  | { kind: 'slip'; qr: SlipQr; ocr: SlipOcrResult };

const MAX_PIXELS = 25_000_000;

/** Reads an uploaded image: a valid slip QR first, then (only then) the OCR. */
@Injectable()
export class SlipReader {
  constructor(private readonly ocr: SlipOcr) {}

  async read(image: Buffer): Promise<SlipRead> {
    // A header whose size cannot be read is not decoded at all: its real size is unknown, so it could be huge.
    const size = imageDimensions(image);
    if (!size || size.width * size.height > MAX_PIXELS) {
      return { kind: 'not-slip' };
    }
    const qr = decodeSlipQr(image);
    if (!qr) return { kind: 'not-slip' };
    try {
      return { kind: 'slip', qr, ocr: await this.ocr.read(image) };
    } catch {
      // A valid QR still supplies evidence for manual review when OCR is unavailable.
      return { kind: 'slip', qr, ocr: { text: '', lines: [] } };
    }
  }
}
