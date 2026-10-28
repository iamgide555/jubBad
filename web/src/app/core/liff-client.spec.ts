import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { LiffClient } from './liff-client';

// The SDK is only ever reached through LiffClient's dynamic import, so replacing the module replaces the SDK.
const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  isLoggedIn: vi.fn(),
  login: vi.fn(),
  isApiAvailable: vi.fn(),
  shareTargetPicker: vi.fn(),
}));
vi.mock('@line/liff', () => ({ default: sdk }));

describe('LiffClient', () => {
  let client: LiffClient;

  beforeEach(() => {
    for (const fn of Object.values(sdk)) fn.mockReset();
    sdk.init.mockResolvedValue(undefined);
    client = TestBed.inject(LiffClient);
  });

  describe('before init', () => {
    it.each([
      ['isLoggedIn', () => client.isLoggedIn()],
      ['login', () => client.login('https://jubbad.test/line-share')],
      ['canShare', () => client.canShare()],
    ])('%s throws a clear error', (_name, call) => {
      expect(call).toThrow('LIFF is not initialised');
    });

    it('share rejects with a clear error and never reaches the SDK', async () => {
      await expect(client.share([])).rejects.toThrow('LIFF is not initialised');
      expect(sdk.shareTargetPicker).not.toHaveBeenCalled();
    });
  });

  describe('after init', () => {
    beforeEach(async () => {
      await client.init('1234567890-AbCdEfGh');
    });

    it('initialises the SDK with the LIFF id', () => {
      expect(sdk.init).toHaveBeenCalledWith({ liffId: '1234567890-AbCdEfGh' });
    });

    it('passes login, login state and share availability through to the SDK', () => {
      sdk.isLoggedIn.mockReturnValue(true);
      sdk.isApiAvailable.mockReturnValue(false);
      expect(client.isLoggedIn()).toBe(true);
      expect(client.canShare()).toBe(false);
      expect(sdk.isApiAvailable).toHaveBeenCalledWith('shareTargetPicker');
      client.login('https://jubbad.test/line-share');
      expect(sdk.login).toHaveBeenCalledWith({ redirectUri: 'https://jubbad.test/line-share' });
    });

    it('share resolves "sent" only for a success status', async () => {
      const messages = [{ type: 'flex' }];
      sdk.shareTargetPicker.mockResolvedValue({ status: 'success' });
      expect(await client.share(messages)).toBe('sent');
      expect(sdk.shareTargetPicker).toHaveBeenCalledWith(messages);
    });

    it('share resolves "cancelled" when the picker is closed (undefined)', async () => {
      sdk.shareTargetPicker.mockResolvedValue(undefined);
      expect(await client.share([])).toBe('cancelled');
    });

    it('share resolves "cancelled" for any other result', async () => {
      sdk.shareTargetPicker.mockResolvedValue({ status: 'failed' });
      expect(await client.share([])).toBe('cancelled');
      sdk.shareTargetPicker.mockResolvedValue({});
      expect(await client.share([])).toBe('cancelled');
    });

    it('share propagates a rejection from the SDK', async () => {
      sdk.shareTargetPicker.mockRejectedValue(new Error('picker blew up'));
      await expect(client.share([])).rejects.toThrow('picker blew up');
    });
  });

  it('does not leave the client initialised when the SDK init fails', async () => {
    sdk.init.mockRejectedValue(new Error('bad liff id'));
    await expect(client.init('nope')).rejects.toThrow('bad liff id');
    expect(() => client.canShare()).toThrow('LIFF is not initialised');
  });
});
