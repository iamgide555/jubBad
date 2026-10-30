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
    const size = imageDimensions(image);
    if (size && size.width * size.height > MAX_PIXELS) {
      return { kind: 'not-slip' };
    }
    const qr = decodeSlipQr(image);
    if (!qr) return { kind: 'not-slip' };
    return { kind: 'slip', qr, ocr: await this.ocr.read(image) };
  }
}
