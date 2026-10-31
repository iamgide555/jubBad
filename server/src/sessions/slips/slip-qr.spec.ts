import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import {
  decodeSlipQr,
  imageDimensions,
  makeSlipPayload,
  parseSlipQr,
} from './slip-qr.js';

async function qrPng(text: string): Promise<Buffer> {
  return QRCode.toBuffer(text, { width: 400, margin: 4 });
}

function toJpeg(png: Buffer, quality = 60): Buffer {
  const decoded = PNG.sync.read(png);
  return jpeg.encode(
    { width: decoded.width, height: decoded.height, data: decoded.data },
    quality,
  ).data;
}

describe('parseSlipQr', () => {
  it('parses a well-formed payload', () => {
    expect(parseSlipQr(makeSlipPayload('004', 'ABC123'))).toEqual({
      bankCode: '004',
      reference: 'ABC123',
    });
  });

  it('parses a known-good payload with a valid CRC', () => {
    expect(
      parseSlipQr(
        '0041000600000101030040220016302230357CPP133315102TH9104C3DC',
      ),
    ).toEqual({ bankCode: '004', reference: '016302230357CPP13331' });
  });

  it('rejects a payload whose reference was altered (CRC mismatch)', () => {
    const good = makeSlipPayload('014', 'ABC123');
    const bad = good.replace('ABC123', 'ABC124');
    expect(bad).not.toBe(good);
    expect(parseSlipQr(bad)).toBeNull();
  });

  it('rejects a PromptPay payload and empty input', () => {
    expect(
      parseSlipQr(
        '00020101021129370016A000000677010111011300660000000005802TH5303764',
      ),
    ).toBeNull();
    expect(parseSlipQr('')).toBeNull();
  });

  it('rejects a payload with a bad bank code, wrong country or truncated TLV', () => {
    expect(parseSlipQr(makeSlipPayload('04', 'ABC123'))).toBeNull();
    expect(parseSlipQr(makeSlipPayload('004', ''))).toBeNull();
    expect(
      parseSlipQr(makeSlipPayload('004', 'ABC123').slice(0, 20)),
    ).toBeNull();
    expect(parseSlipQr('zz')).toBeNull();
  });
});

describe('decodeSlipQr', () => {
  it('decodes a PNG slip QR', async () => {
    const png = await qrPng(makeSlipPayload('004', 'ABC123'));
    expect(decodeSlipQr(png)).toEqual({ bankCode: '004', reference: 'ABC123' });
  });

  it('decodes a JPEG re-encoded at low quality', async () => {
    const png = await qrPng(makeSlipPayload('025', 'XYZ789'));
    expect(decodeSlipQr(toJpeg(png))).toEqual({
      bankCode: '025',
      reference: 'XYZ789',
    });
  });

  it('returns null for a QR that is not a slip QR', async () => {
    expect(decodeSlipQr(await qrPng('https://example.com/hello'))).toBeNull();
  });

  it('returns null for non-images and corrupt images', async () => {
    expect(decodeSlipQr(Buffer.from('not an image'))).toBeNull();
    expect(decodeSlipQr(Buffer.alloc(0))).toBeNull();
    const png = await qrPng(makeSlipPayload('004', 'ABC123'));
    expect(decodeSlipQr(png.subarray(0, 60))).toBeNull();
    expect(
      decodeSlipQr(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02])),
    ).toBeNull();
  });

  it('returns null for an image wider than 8000 px', () => {
    const png = new PNG({ width: 8001, height: 1 });
    expect(decodeSlipQr(PNG.sync.write(png))).toBeNull();
  });
});

describe('imageDimensions', () => {
  it('reads PNG and JPEG sizes from the headers', async () => {
    const png = await qrPng('hello');
    const size = PNG.sync.read(png);
    expect(imageDimensions(png)).toEqual({
      width: size.width,
      height: size.height,
    });
    expect(imageDimensions(toJpeg(png))).toEqual({
      width: size.width,
      height: size.height,
    });
  });

  /** SOI, an APP0 segment, then a frame header with `marker` (after optional fill bytes). */
  function jpegHeader(marker: number, width: number, height: number, fill = 0): Buffer {
    const app0 = [0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0];
    const sof = [0xff, marker, 0x00, 0x11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3];
    return Buffer.from([0xff, 0xd8, ...app0, ...Array(fill).fill(0xff), ...sof, ...Array(9).fill(0)]);
  }

  it('reads a progressive (SOF2) JPEG frame header', () => {
    expect(imageDimensions(jpegHeader(0xc2, 1170, 2532))).toEqual({
      width: 1170,
      height: 2532,
    });
  });

  it('skips fill bytes before a marker', () => {
    expect(imageDimensions(jpegHeader(0xc0, 640, 480, 3))).toEqual({
      width: 640,
      height: 480,
    });
  });

  it('returns null when the segment walk hits a byte that is not a marker', () => {
    const header = jpegHeader(0xc0, 640, 480);
    // Corrupt the byte where the frame header's marker should start.
    const broken = Buffer.from(header);
    broken[2 + 18] = 0x00;
    expect(imageDimensions(broken)).toBeNull();
  });

  it('returns null for a frame header cut short', () => {
    expect(imageDimensions(jpegHeader(0xc0, 640, 480).subarray(0, 2 + 18 + 6))).toBeNull();
  });

  it('returns null for unknown or truncated input', () => {
    expect(imageDimensions(Buffer.from('not an image'))).toBeNull();
    expect(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
    expect(imageDimensions(Buffer.alloc(0))).toBeNull();
  });
});
