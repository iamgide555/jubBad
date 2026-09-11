import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AuthService } from './auth.service';
import { environment } from '../../environments/environment';

const B = environment.apiBaseUrl;

describe('AuthService', () => {
  let service: AuthService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(AuthService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('starts out not knowing whether it is signed in', () => {
    expect(service.isAuthed()).toBe(false);
  });

  it('reports signed in after a successful login', async () => {
    const result = service.login('host@example.test', 'a real password');
    const req = httpMock.expectOne(`${B}/auth/login`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ email: 'host@example.test', password: 'a real password' });
    req.flush({ authenticated: true });

    // login() does not carry role/email itself, so it asks /auth/me for them
    // — a second await inside login(), which needs a microtask tick to reach
    // the point where that request has actually been issued.
    await Promise.resolve();
    httpMock
      .expectOne(`${B}/auth/me`)
      .flush({ authenticated: true, role: 'host', email: 'host@example.test' });

    expect(await result).toBe(true);
    expect(service.isAuthed()).toBe(true);
    expect(service.role()).toBe('host');
    expect(service.email()).toBe('host@example.test');
  });

  it('never stores the password itself — the cookie is the credential', async () => {
    const result = service.login('host@example.test', 'a real password');
    httpMock.expectOne(`${B}/auth/login`).flush({ authenticated: true });
    await Promise.resolve();
    httpMock
      .expectOne(`${B}/auth/me`)
      .flush({ authenticated: true, role: 'host', email: 'host@example.test' });
    await result;

    // If the password were kept anywhere reachable from script, choosing an
    // httpOnly cookie over localStorage would have bought nothing.
    const values = Object.values(service as unknown as Record<string, unknown>);
    expect(values.filter((v) => typeof v === 'string')).not.toContain('a real password');
    expect(Object.keys(localStorage)).toHaveLength(0);
    expect(Object.keys(sessionStorage)).toHaveLength(0);
  });

  it('reports failure on rejected credentials without throwing', async () => {
    const result = service.login('host@example.test', 'wrong');
    httpMock
      .expectOne(`${B}/auth/login`)
      .flush({ message: 'nope' }, { status: 401, statusText: 'Unauthorized' });

    expect(await result).toBe(false);
    expect(service.isAuthed()).toBe(false);
  });

  it('distinguishes a throttled response so the user can be told to wait', async () => {
    const result = service.login('host@example.test', 'wrong');
    httpMock
      .expectOne(`${B}/auth/login`)
      .flush({ message: 'slow down' }, { status: 429, statusText: 'Too Many Requests' });

    expect(await result).toBe('throttled');
  });

  it('checks the server rather than trusting its own flag', async () => {
    const result = service.check();
    httpMock
      .expectOne(`${B}/auth/me`)
      .flush({ authenticated: true, role: 'admin', email: 'a@x.test' });
    expect(await result).toBe(true);
    expect(service.isAuthed()).toBe(true);
    expect(service.role()).toBe('admin');
  });

  it('treats an unreachable server as not signed in', async () => {
    const result = service.check();
    httpMock
      .expectOne(`${B}/auth/me`)
      .flush(null, { status: 500, statusText: 'Server Error' });
    expect(await result).toBe(false);
  });

  it('clears its flag and role on logout', async () => {
    const login = service.login('host@example.test', 'a real password');
    httpMock.expectOne(`${B}/auth/login`).flush({ authenticated: true });
    await Promise.resolve();
    httpMock
      .expectOne(`${B}/auth/me`)
      .flush({ authenticated: true, role: 'host', email: 'host@example.test' });
    await login;

    const out = service.logout();
    httpMock.expectOne(`${B}/auth/logout`).flush({ authenticated: false });
    await out;

    expect(service.isAuthed()).toBe(false);
    expect(service.role()).toBeNull();
    expect(service.email()).toBeNull();
  });
});
