import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { environment } from '../../environments/environment';
import { SignupService } from './signup.service';

const B = environment.apiBaseUrl;
const ACCESS = 'line-access-token-ABC';

describe('SignupService', () => {
  let service: SignupService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(SignupService);
    httpMock = TestBed.inject(HttpTestingController);
  });
  afterEach(() => httpMock.verify());

  describe('register', () => {
    it('posts the email, password and the trap field', async () => {
      const result = service.register('a@b.test', 'password123', 'trap');
      const req = httpMock.expectOne(`${B}/auth/register`);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ email: 'a@b.test', password: 'password123', website: 'trap' });
      req.flush({ authenticated: true }, { status: 201, statusText: 'Created' });
      expect(await result).toBe('ok');
    });

    it.each([
      [409, { code: 'EMAIL_TAKEN' }, 'email-taken'],
      [429, {}, 'rate'],
      [400, {}, 'invalid'],
      [500, {}, 'error'],
    ] as const)('maps %s to %s', async (status, body, expected) => {
      const result = service.register('a@b.test', 'password123', '');
      httpMock.expectOne(`${B}/auth/register`).flush(body, { status, statusText: 'x' });
      expect(await result).toBe(expected);
    });
  });

  it('reads the sign-up info', async () => {
    const result = service.info();
    httpMock.expectOne(`${B}/auth/signup-info`).flush({ liffId: 'L1', lineSignupUrl: 'https://liff.line.me/L1/signup', botAddUrl: null, contactUrl: null });
    expect(await result).toEqual({ liffId: 'L1', lineSignupUrl: 'https://liff.line.me/L1/signup', botAddUrl: null, contactUrl: null });
  });

  it('sends the LINE token in the header only, never in the body or URL', async () => {
    const result = service.lineStatus(ACCESS);
    const req = httpMock.expectOne(`${B}/auth/line/status`);
    expect(req.request.headers.get('X-Line-Access-Token')).toBe(ACCESS);
    expect(JSON.stringify(req.request.body)).not.toContain(ACCESS);
    expect(req.request.urlWithParams).not.toContain(ACCESS);
    req.flush({ lineDisplayName: 'Somchai', registered: false, trialAvailable: true }, { status: 200, statusText: 'OK' });
    expect(await result).toEqual({ lineDisplayName: 'Somchai', registered: false, trialAvailable: true });
  });

  it.each([
    [401, 'unauthorized'],
    [503, 'unavailable'],
    [500, 'error'],
  ] as const)('lineStatus maps %s to %s', async (status, expected) => {
    const result = service.lineStatus(ACCESS);
    httpMock.expectOne(`${B}/auth/line/status`).flush({}, { status, statusText: 'x' });
    expect(await result).toBe(expected);
  });

  describe('lineSignup', () => {
    it('returns the trial end and friend flag', async () => {
      const result = service.lineSignup(ACCESS, 'a@b.test', 'password123');
      const req = httpMock.expectOne(`${B}/auth/line/signup`);
      expect(req.request.headers.get('X-Line-Access-Token')).toBe(ACCESS);
      expect(req.request.body).toEqual({ email: 'a@b.test', password: 'password123' });
      req.flush({ authenticated: true, trialUntil: '2026-12-16T16:59:59.999Z', botFriend: false }, { status: 201, statusText: 'Created' });
      expect(await result).toEqual({ trialUntil: '2026-12-16T16:59:59.999Z', botFriend: false });
    });

    it.each([
      [409, { code: 'LINE_ALREADY_REGISTERED' }, 'line-registered'],
      [409, { code: 'EMAIL_TAKEN' }, 'email-taken'],
      [429, {}, 'rate'],
      [401, {}, 'unauthorized'],
      [503, {}, 'unavailable'],
      [400, {}, 'invalid'],
      [500, {}, 'error'],
    ] as const)('maps %s %j to %s', async (status, body, expected) => {
      const result = service.lineSignup(ACCESS, 'a@b.test', 'password123');
      httpMock.expectOne(`${B}/auth/line/signup`).flush(body, { status, statusText: 'x' });
      expect(await result).toBe(expected);
    });
  });

  describe('lineLink', () => {
    it('returns the trial end', async () => {
      const result = service.lineLink(ACCESS, 'a@b.test', 'password123');
      const req = httpMock.expectOne(`${B}/auth/line/link`);
      expect(req.request.headers.get('X-Line-Access-Token')).toBe(ACCESS);
      req.flush({ linked: true, trialUntil: null, botFriend: false }, { status: 200, statusText: 'OK' });
      expect(await result).toEqual({ trialUntil: null, botFriend: false });
    });

    it.each([
      [401, { code: 'BAD_CREDENTIALS' }, 'bad-credentials'],
      [401, {}, 'unauthorized'],
      [409, { code: 'ACCOUNT_ALREADY_LINKED' }, 'account-linked'],
      [409, { code: 'LINE_ALREADY_LINKED' }, 'line-linked'],
      [429, {}, 'rate'],
      [503, {}, 'unavailable'],
      [500, {}, 'error'],
    ] as const)('maps %s %j to %s', async (status, body, expected) => {
      const result = service.lineLink(ACCESS, 'a@b.test', 'password123');
      httpMock.expectOne(`${B}/auth/line/link`).flush(body, { status, statusText: 'x' });
      expect(await result).toBe(expected);
    });
  });
});
