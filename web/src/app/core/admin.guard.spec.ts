import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { provideRouter } from '@angular/router';
import { adminGuard } from './admin.guard';
import { AuthService } from './auth.service';

function runGuard(url: string) {
  return TestBed.runInInjectionContext(() =>
    adminGuard({} as never, { url } as never)
  ) as Promise<boolean | UrlTree>;
}

describe('adminGuard', () => {
  let checkResult: boolean;

  beforeEach(() => {
    checkResult = false;
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: { check: () => Promise.resolve(checkResult) } },
      ],
    });
  });

  it('lets a signed-in visitor through', async () => {
    checkResult = true;
    expect(await runGuard('/')).toBe(true);
  });

  it('sends a signed-out visitor to the login page', async () => {
    const result = await runGuard('/');
    expect(result).toBeInstanceOf(UrlTree);
    expect((result as UrlTree).toString()).toContain('/login');
  });

  it('remembers where they were going so login can return them', async () => {
    // Otherwise a bookmarked session link always dumps the host on the home
    // page after signing in, and they have to find the session again.
    const result = (await runGuard('/s/abc123')) as UrlTree;
    expect(result.queryParams['returnUrl']).toBe('/s/abc123');
  });

  it('asks the server every time rather than trusting a cached flag', async () => {
    let calls = 0;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: AuthService,
          useValue: {
            check: () => {
              calls++;
              return Promise.resolve(true);
            },
          },
        },
      ],
    });
    await runGuard('/');
    await runGuard('/g/abc');
    expect(calls).toBe(2);
  });

  it('resolves against the real Router so the redirect is a usable UrlTree', async () => {
    const router = TestBed.inject(Router);
    const result = (await runGuard('/g/x')) as UrlTree;
    expect(router.serializeUrl(result)).toBe('/login?returnUrl=%2Fg%2Fx');
  });
});
