import { uploadableSlip } from './slip-image';

const heic = () => new File([new Uint8Array([1, 2, 3])], 'slip.heic', { type: 'image/heic' });

describe('uploadableSlip', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(['image/jpeg', 'image/png'])('sends %s through untouched', async (type) => {
    const file = new File([new Uint8Array([1])], 'slip', { type });
    const bitmap = vi.fn();
    vi.stubGlobal('createImageBitmap', bitmap);
    expect(await uploadableSlip(file)).toBe(file);
    expect(bitmap).not.toHaveBeenCalled();
  });

  it('redraws a HEIC pick as a JPEG on a white canvas, at its own size', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1026, height: 1598, close })));
    const jpeg = new Blob(['jpeg'], { type: 'image/jpeg' });
    const ctx = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => ctx), toBlob: vi.fn((cb: (b: Blob) => void) => cb(jpeg)) };
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLElement);

    expect(await uploadableSlip(heic())).toBe(jpeg);
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.92);
    expect([canvas.width, canvas.height]).toEqual([1026, 1598]);
    expect(ctx.fillStyle).toBe('#fff');
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1026, 1598);
    expect(close).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('shrinks a huge photo to at most 4096 on its long side', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 8192, height: 4096, close: vi.fn() })));
    const ctx = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => ctx), toBlob: vi.fn((cb: (b: Blob) => void) => cb(new Blob())) };
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLElement);
    await uploadableSlip(heic());
    expect([canvas.width, canvas.height]).toEqual([4096, 2048]);
    vi.restoreAllMocks();
  });

  it('falls back to the original when the browser cannot decode it', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('cannot decode'); }));
    const file = heic();
    expect(await uploadableSlip(file)).toBe(file);
  });

  it('falls back to the original when the canvas gives no blob', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 10, height: 10, close: vi.fn() })));
    const ctx = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => ctx), toBlob: vi.fn((cb: (b: Blob | null) => void) => cb(null)) };
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLElement);
    const file = heic();
    expect(await uploadableSlip(file)).toBe(file);
    vi.restoreAllMocks();
  });
});
