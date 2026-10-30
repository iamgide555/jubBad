import QRCode from 'qrcode';
import { describe, expect, it, vi } from 'vitest';
import { makeSlipPayload } from './slip-qr.js';
import { SlipReader } from './slip-reader.js';
import type { SlipOcr, SlipOcrResult } from './slip-ocr.js';

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
});
