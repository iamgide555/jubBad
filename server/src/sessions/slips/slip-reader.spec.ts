import QRCode from 'qrcode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as slipQr from './slip-qr.js';
import { makeSlipPayload } from './slip-qr.js';
import { SlipReader } from './slip-reader.js';
import type { SlipOcr, SlipOcrResult } from './slip-ocr.js';

// The real decoder, wrapped so a test can prove the size guard runs before it.
vi.mock('./slip-qr.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./slip-qr.js')>();
  return { ...actual, decodeSlipQr: vi.fn(actual.decodeSlipQr) };
});

function fakeOcr(result: SlipOcrResult) {
  const read = vi.fn(async () => result);
  return { ocr: { read } as unknown as SlipOcr, read };
}

const OCR_RESULT: SlipOcrResult = {
  text: 'โอนเงินสำเร็จ 120.00 บาท',
  lines: [{ text: '120.00 บาท', y0: 10, y1: 30 }],
};

async function qrPng(text: string): Promise<Buffer> {
  return QRCode.toBuffer(text, { width: 400, margin: 4 });
}

/** A PNG signature + IHDR only: enough for the size guard, never decodable. */
function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe('SlipReader', () => {
  afterEach(() => vi.mocked(slipQr.decodeSlipQr).mockClear());

  it('returns not-slip without calling OCR when there is no slip QR', async () => {
    const { ocr, read } = fakeOcr(OCR_RESULT);
    const reader = new SlipReader(ocr);
    const image = await qrPng('https://example.test/not-a-slip');
    expect(await reader.read(image)).toEqual({ kind: 'not-slip' });
    expect(await reader.read(Buffer.from('not an image'))).toEqual({
      kind: 'not-slip',
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('returns the QR and the OCR result for a valid slip QR', async () => {
    const { ocr, read } = fakeOcr(OCR_RESULT);
    const reader = new SlipReader(ocr);
    const image = await qrPng(makeSlipPayload('004', 'REF123456'));
    expect(await reader.read(image)).toEqual({
      kind: 'slip',
      qr: { bankCode: '004', reference: 'REF123456' },
      ocr: OCR_RESULT,
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(image);
  });

  it('lets an OCR failure propagate to the caller', async () => {
    const read = vi.fn(async () => {
      throw new Error('ocr down');
    });
    const reader = new SlipReader({ read } as unknown as SlipOcr);
    const image = await qrPng(makeSlipPayload('004', 'REF123456'));
    await expect(reader.read(image)).rejects.toThrow('ocr down');
  });

  it('treats an image over 25 megapixels as not-slip without OCR', async () => {
    const { ocr, read } = fakeOcr(OCR_RESULT);
    const reader = new SlipReader(ocr);
    expect(await reader.read(pngHeader(6000, 5000))).toEqual({
      kind: 'not-slip',
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('treats an image whose size cannot be read from its header as not-slip, before QR decode or OCR', async () => {
    const { ocr, read } = fakeOcr(OCR_RESULT);
    const reader = new SlipReader(ocr);
    // Even if the decoder would find a slip QR in it, an unreadable header never gets that far.
    vi.mocked(slipQr.decodeSlipQr).mockReturnValueOnce({ bankCode: '004', reference: 'REF123456' });
    // A JPEG whose segment walk stops at a byte that is not a marker.
    const odd = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0x12, 0x34, 0x56, 0x78]);
    expect(slipQr.imageDimensions(odd)).toBeNull();
    expect(await reader.read(odd)).toEqual({ kind: 'not-slip' });
    expect(slipQr.decodeSlipQr).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});
