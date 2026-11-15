import QRCode from 'qrcode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('keeps valid slip readable for host review when OCR fails', async () => {
    const { ocr, read } = fakeOcr(OCR_RESULT);
    read.mockRejectedValueOnce(new Error('worker failed'));
    const reader = new SlipReader(ocr);
    const image = await qrPng(makeSlipPayload('004', 'TEST12345678'));
    const result = await reader.read(image);
    expect(result).toMatchObject({kind:'slip', ocr:{text:'',lines:[]}});
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

  it('does not expose OCR worker errors in host review data', async () => {
    const read = vi.fn(async () => {
      throw new Error('ocr down');
    });
    const reader = new SlipReader({ read } as unknown as SlipOcr);
    const image = await qrPng(makeSlipPayload('004', 'REF123456'));
    expect(JSON.stringify(await reader.read(image))).not.toContain('ocr down');
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

  describe('says why an image was not a slip, never the image', () => {
    // Restores only the console spy: restoreAllMocks would also reset the wrapped decoder above.
    let spies: Array<{ mockRestore(): void }> = [];
    const warned = () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      spies.push(spy);
      return spy;
    };
    // An earlier test queues a one-shot decoder result it never consumes; drop it so it cannot leak into these.
    beforeEach(() => vi.mocked(slipQr.decodeSlipQr).mockReset());
    afterEach(() => {
      spies.forEach((s) => s.mockRestore());
      spies = [];
    });

    it('names a HEIC photo as an unsupported format', async () => {
      const spy = warned();
      // ISO-BMFF: 4-byte box size, then "ftyp", then the brand.
      const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(40)]);
      expect(await new SlipReader(fakeOcr(OCR_RESULT).ocr).read(heic)).toEqual({ kind: 'not-slip' });
      expect(spy).toHaveBeenCalledWith('[slip-reader] not a slip: unsupported format heic, 52 bytes');
    });

    it('names bytes it cannot place, without echoing them beyond a 4-byte signature', async () => {
      const spy = warned();
      await new SlipReader(fakeOcr(OCR_RESULT).ocr).read(Buffer.from('hello world, not an image'));
      expect(spy).toHaveBeenCalledWith('[slip-reader] not a slip: unsupported format unknown(68656c6c), 25 bytes');
    });

    it('names a readable image with no slip QR', async () => {
      const spy = warned();
      await new SlipReader(fakeOcr(OCR_RESULT).ocr).read(await qrPng('https://example.com/not-a-slip'));
      expect(spy).toHaveBeenCalledWith(expect.stringMatching(/^\[slip-reader\] not a slip: no valid slip QR in a png, \d+ bytes$/));
    });

    it('names an oversized image', async () => {
      const spy = warned();
      await new SlipReader(fakeOcr(OCR_RESULT).ocr).read(pngHeader(6000, 6000));
      expect(spy).toHaveBeenCalledWith('[slip-reader] not a slip: image too large, 6000x6000, 33 bytes');
    });

    it('stays silent for a real slip', async () => {
      const spy = warned();
      await new SlipReader(fakeOcr(OCR_RESULT).ocr).read(await qrPng(makeSlipPayload('014', 'REF1')));
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
