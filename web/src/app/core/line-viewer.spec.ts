import { TestBed } from '@angular/core/testing';
import { LiffClient } from './liff-client';
import { LineViewer } from './line-viewer';
import { SignupService } from './signup.service';

describe('LineViewer', () => {
  let viewer: LineViewer;
  let svc: { info: ReturnType<typeof vi.fn> };
  let liff: {
    init: ReturnType<typeof vi.fn>;
    isLoggedIn: ReturnType<typeof vi.fn>;
    login: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
    getAccessToken: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    sessionStorage.clear();
    svc = { info: vi.fn().mockResolvedValue({ liffId: 'L1', lineSignupUrl: null, botAddUrl: 'https://lin.ee/bot' }) };
    liff = {
      init: vi.fn().mockResolvedValue(undefined),
      isLoggedIn: vi.fn().mockReturnValue(true),
      login: vi.fn(),
      logout: vi.fn(),
      getAccessToken: vi.fn().mockReturnValue('TOKEN'),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: SignupService, useValue: svc },
        { provide: LiffClient, useValue: liff },
      ],
    });
    viewer = TestBed.inject(LineViewer);
  });

  it('hands back the access token and the bot link when LIFF is ready', async () => {
    expect(await viewer.start()).toEqual({ kind: 'ready', accessToken: 'TOKEN', botAddUrl: 'https://lin.ee/bot' });
    expect(liff.init).toHaveBeenCalledWith('L1');
  });

  it('reads the sign-up info once, however many times it starts', async () => {
    await viewer.start();
    await viewer.start();
    expect(svc.info).toHaveBeenCalledTimes(1);
  });

  it('is an error when the server cannot be reached, and tries the server again next time', async () => {
    svc.info.mockRejectedValueOnce(new Error('offline'));
    expect(await viewer.start()).toEqual({ kind: 'error' });
    expect(await viewer.start()).toMatchObject({ kind: 'ready' });
  });

  it('is unavailable when no LIFF id is configured, and never starts LIFF', async () => {
    svc.info.mockResolvedValue({ liffId: null, lineSignupUrl: null, botAddUrl: null, contactUrl: null });
    expect(await viewer.start()).toEqual({ kind: 'unavailable' });
    expect(liff.init).not.toHaveBeenCalled();
  });

  it('runs LIFF init again after it failed, but only once after it worked', async () => {
    liff.init.mockRejectedValueOnce(new Error('init'));
    expect(await viewer.start()).toEqual({ kind: 'error' });
    expect(await viewer.start()).toMatchObject({ kind: 'ready' });
    await viewer.start();
    expect(liff.init).toHaveBeenCalledTimes(2);
  });

  it('sends a viewer who is not logged in through LINE login and says it is redirecting', async () => {
    liff.isLoggedIn.mockReturnValue(false);
    expect(await viewer.start()).toEqual({ kind: 'redirecting' });
    expect(liff.login).toHaveBeenCalledWith(window.location.href);
  });

  it('is an error, not a hang, when LINE login itself throws', async () => {
    liff.isLoggedIn.mockReturnValue(false);
    liff.login.mockImplementation(() => {
      throw new Error('login blocked');
    });
    expect(await viewer.start()).toEqual({ kind: 'error' });
  });

  it('is an error when LIFF has no access token', async () => {
    liff.getAccessToken.mockReturnValue(null);
    expect(await viewer.start()).toEqual({ kind: 'error' });
  });

  it('restart signs LINE out and back in, so a refused or expired token is replaced by a fresh one', async () => {
    await viewer.start();
    expect(await viewer.restart()).toEqual({ kind: 'redirecting' });
    expect(liff.logout).toHaveBeenCalledTimes(1);
    expect(liff.login).toHaveBeenCalledWith(window.location.href);
  });

  describe('restart cannot loop', () => {
    afterEach(() => vi.restoreAllMocks());

    it('refuses a second restart within a minute: a token LINE keeps refusing would otherwise bounce between LINE login and the page for ever', async () => {
      expect(await viewer.restart()).toEqual({ kind: 'redirecting' });
      // The page reloads after LINE login, so a new LineViewer; the memory lives in the browser tab.
      expect(await TestBed.inject(LineViewer).restart()).toEqual({ kind: 'error' });
      expect(liff.logout).toHaveBeenCalledTimes(1);
      expect(liff.login).toHaveBeenCalledTimes(1);
    });

    it('allows it again after a minute, so a person who tries again later gets a fresh login', async () => {
      const t = Date.now();
      const now = vi.spyOn(Date, 'now').mockReturnValue(t);
      expect(await viewer.restart()).toEqual({ kind: 'redirecting' });
      now.mockReturnValue(t + 61_000);
      expect(await viewer.restart()).toEqual({ kind: 'redirecting' });
    });

    it('still restarts when the browser will not let the page remember (private mode)', async () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('denied');
      });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('denied');
      });
      expect(await viewer.restart()).toEqual({ kind: 'redirecting' });
    });
  });
});

