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
    if (!size) return notSlip(`unsupported format ${formatOf(image)}, ${image.length} bytes`);
    if (size.width * size.height > MAX_PIXELS) {
      return notSlip(`image too large, ${size.width}x${size.height}, ${image.length} bytes`);
    }
    const qr = decodeSlipQr(image);
    if (!qr) return notSlip(`no valid slip QR in a ${formatOf(image)}, ${image.length} bytes`);
    try {
      return { kind: 'slip', qr, ocr: await this.ocr.read(image) };
    } catch {
      // A valid QR still supplies evidence for manual review when OCR is unavailable.
      return { kind: 'slip', qr, ocr: { text: '', lines: [] } };
    }
  }
}

/** Only the reason is logged (format, size): the image, its text and who sent it never are. */
function notSlip(reason: string): { kind: 'not-slip' } {
  console.warn(`[slip-reader] not a slip: ${reason}`);
  return { kind: 'not-slip' };
}

/**
 * What kind of file this is, by its first bytes. Anything unplaced shows only its first 4 bytes in hex, enough to
 * recognise a format without echoing the content.
 */
function formatOf(image: Buffer): string {
  if (image[0] === 0xff && image[1] === 0xd8) return 'jpeg';
  if (image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47) return 'png';
  if (image.length >= 12 && image.toString('latin1', 4, 8) === 'ftyp') {
    const brand = image.toString('latin1', 8, 12);
    return /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand) ? 'heic' : 'iso-bmff';
  }
  if (image.length >= 12 && image.toString('latin1', 0, 4) === 'RIFF' && image.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return `unknown(${image.subarray(0, 4).toString('hex')})`;
}
