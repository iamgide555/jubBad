import jpeg from 'jpeg-js';
import jsQRModule from 'jsqr';
import type { QRCode } from 'jsqr';
import { PNG } from 'pngjs';

// jsqr is CJS whose module.exports is the function itself; under NodeNext the
// default import is typed as the module namespace, so give it its real shape.
const jsQR = jsQRModule as unknown as (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => QRCode | null;

/** What a Thai bank-transfer slip QR carries: who sent it and which transfer. */
export interface SlipQr {
  bankCode: string;
  reference: string;
}

const MAX_SIDE_PX = 8000;
const API_ID = '000001';

interface TlvItem {
  tag: string;
  value: string;
}

/** Flat TLV: 2-digit tag + 2-digit decimal length + value. Null if malformed. */
function readTlv(text: string): TlvItem[] | null {
  const items: TlvItem[] = [];
  let i = 0;
  while (i < text.length) {
    if (i + 4 > text.length) return null;
    const tag = text.slice(i, i + 2);
    const lenText = text.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lenText)) return null;
    const len = Number(lenText);
    const end = i + 4 + len;
    if (end > text.length) return null;
    items.push({ tag, value: text.slice(i + 4, end) });
    i = end;
  }
  return items;
}

/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no final xor. */
function crc16(text: string): string {
  let crc = 0xffff;
  for (let i = 0; i < text.length; i++) {
    crc ^= (text.charCodeAt(i) & 0xff) << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function tlv(tag: string, value: string): string {
  return `${tag}${String(value.length).padStart(2, '0')}${value}`;
}

/**
 * Validates a slip QR payload (structure, API id, country, CRC) and returns
 * the sending bank and transaction reference, or null for anything else.
 */
export function parseSlipQr(payload: string): SlipQr | null {
  if (typeof payload !== 'string' || payload.length === 0) return null;
  const outer = readTlv(payload);
  if (!outer || outer.length !== 3) return null;
  const [data, country, crc] = outer;
  if (data.tag !== '00' || country.tag !== '51' || crc.tag !== '91')
    return null;
  if (country.value !== 'TH' || !/^[0-9A-F]{4}$/.test(crc.value)) return null;
  if (crc16(payload.slice(0, -4)) !== crc.value) return null;

  const inner = readTlv(data.value);
  if (!inner || inner.length !== 3) return null;
  const [apiId, bank, ref] = inner;
  if (apiId.tag !== '00' || apiId.value !== API_ID) return null;
  if (bank.tag !== '01' || !/^\d{3}$/.test(bank.value)) return null;
  if (ref.tag !== '02' || ref.value.length === 0) return null;
  return { bankCode: bank.value, reference: ref.value };
}

/** Builds a valid slip payload (lengths and CRC computed). For tests. */
export function makeSlipPayload(bankCode: string, reference: string): string {
  const inner = tlv('00', API_ID) + tlv('01', bankCode) + tlv('02', reference);
  const body = tlv('00', inner) + tlv('51', 'TH') + '9104';
  return body + crc16(body);
}

interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function decodePixels(image: Buffer): Pixels | null {
  const isJpeg = image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
  const isPng =
    image[0] === 0x89 &&
    image[1] === 0x50 &&
    image[2] === 0x4e &&
    image[3] === 0x47;
  if (isPng) {
    // Width/height sit in the IHDR chunk; check before inflating anything.
    if (image.length < 24) return null;
    const w = image.readUInt32BE(16);
    const h = image.readUInt32BE(20);
    if (w > MAX_SIDE_PX || h > MAX_SIDE_PX) return null;
    const png = PNG.sync.read(image);
    return {
      width: png.width,
      height: png.height,
      data: new Uint8ClampedArray(png.data),
    };
  }
  if (isJpeg) {
    const jpg = jpeg.decode(image, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: (MAX_SIDE_PX * MAX_SIDE_PX) / 1_000_000,
    });
    if (jpg.width > MAX_SIDE_PX || jpg.height > MAX_SIDE_PX) return null;
    return {
      width: jpg.width,
      height: jpg.height,
      data: new Uint8ClampedArray(jpg.data),
    };
  }
  return null;
}

/** Finds and validates a slip QR in a JPEG or PNG. Never throws. */
export function decodeSlipQr(image: Buffer): SlipQr | null {
  try {
    const pixels = decodePixels(image);
    if (!pixels) return null;
    const code = jsQR(pixels.data, pixels.width, pixels.height);
    if (!code) return null;
    return parseSlipQr(code.data);
  } catch {
    return null;
  }
}

/**
 * Pixel size of a JPEG or PNG read from its header alone (nothing is decoded),
 * or null when the format is unknown or the header is truncated.
 */
export function imageDimensions(
  image: Buffer,
): { width: number; height: number } | null {
  if (
    image.length >= 24 &&
    image[0] === 0x89 &&
    image[1] === 0x50 &&
    image[2] === 0x4e &&
    image[3] === 0x47
  ) {
    return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
  }
  if (image[0] !== 0xff || image[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= image.length) {
    if (image[i] !== 0xff) return null;
    const marker = image[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2; // standalone markers carry no length
      continue;
    }
    const segmentLength = image.readUInt16BE(i + 2);
    // SOF0-SOF15 except DHT (c4), JPG (c8) and DAC (cc) start a frame header.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      if (i + 9 > image.length) return null;
      return {
        height: image.readUInt16BE(i + 5),
        width: image.readUInt16BE(i + 7),
      };
    }
    i += 2 + segmentLength;
  }
  return null;
}
