/** What the server's slip reader can decode. Anything else (an iPhone's HEIC, WebP) is redrawn as JPEG first. */
const READABLE = new Set(['image/jpeg', 'image/png']);
/** A phone photo is far larger than a QR needs; this bounds the upload and the canvas. */
const MAX_SIDE = 4096;
const JPEG_QUALITY = 0.92;

/**
 * The picked photo in a format the server can read. JPEG and PNG go through untouched. For anything else the browser's own
 * decoder redraws it as a JPEG (iOS decodes HEIC itself, so this works inside LINE on an iPhone). If the browser cannot
 * decode it either, the original is sent and the server answers "not a slip" like it would have anyway.
 */
export async function uploadableSlip(file: File): Promise<Blob> {
  if (READABLE.has(file.type)) return file;
  try {
    return (await redrawAsJpeg(file)) ?? file;
  } catch {
    return file;
  }
}

async function redrawAsJpeg(file: File): Promise<Blob | null> {
  const picture = await decode(file);
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(picture.width, picture.height));
    const width = Math.max(1, Math.round(picture.width * scale));
    const height = Math.max(1, Math.round(picture.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // JPEG has no alpha: a transparent pixel would turn black and could swallow the QR.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(picture.source, 0, 0, width, height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
  } finally {
    picture.release();
  }
}

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

async function decode(file: File): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}
