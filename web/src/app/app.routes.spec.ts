import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { routes } from './app.routes';
import { AuthService } from './core/auth.service';
import { GroupEntry } from './pages/group-entry/group-entry';
import { SessionDashboard } from './pages/session-dashboard/session-dashboard';
import { SessionDisplay } from './pages/session-display/session-display';
import { PlayerProfile } from './pages/player-profile/player-profile';
import { Landing } from './pages/landing/landing';
import { ResetPassword } from './pages/reset-password/reset-password';
import { Admin } from './pages/admin/admin';

/**
 * A stubbed AuthService rather than the real one: these tests are about which
 * component a URL resolves to, and whether the guard is attached at all. The
 * guard's own behaviour is covered in core/admin.guard.spec.ts.
 */
function configure(signedIn: boolean) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter(routes),
      // Testing backend, so no component's constructor reaches the network.
      provideHttpClient(),
      provideHttpClientTesting(),
      {
        provide: AuthService,
        // role() is read by Landing (the admin-console link) even for a
        // plain host, so the stub needs it regardless of what this
        // particular test is checking.
        useValue: { check: () => Promise.resolve(signedIn), role: () => null },
      },
    ],
  });
}

describe('app routes', () => {
  describe('signed in', () => {
    beforeEach(() => configure(true));

    it('/ resolves to Landing', async () => {
      const harness = await RouterTestingHarness.create();
      expect(await harness.navigateByUrl('/', Landing)).toBeInstanceOf(Landing);
    });

    it('/g/:groupCode resolves to GroupEntry', async () => {
      const harness = await RouterTestingHarness.create();
      expect(await harness.navigateByUrl('/g/abc123', GroupEntry)).toBeInstanceOf(GroupEntry);
    });

    it('/s/:sessionCode resolves to SessionDashboard', async () => {
      const harness = await RouterTestingHarness.create();
      expect(await harness.navigateByUrl('/s/xyz789', SessionDashboard)).toBeInstanceOf(
        SessionDashboard
      );
    });

    it('/s/:sessionCode/display resolves to SessionDisplay', async () => {
      const harness = await RouterTestingHarness.create();
      expect(await harness.navigateByUrl('/s/xyz789/display', SessionDisplay)).toBeInstanceOf(
        SessionDisplay
      );
    });
  });

  describe('signed in as admin', () => {
    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [
          provideRouter(routes),
          provideHttpClient(),
          provideHttpClientTesting(),
          {
            provide: AuthService,
            useValue: { check: () => Promise.resolve(true), role: () => 'admin' },
          },
        ],
      });
    });

    it('/admin resolves to Admin', async () => {
      const harness = await RouterTestingHarness.create();
      expect(await harness.navigateByUrl('/admin', Admin)).toBeInstanceOf(Admin);
    });
  });

  describe('signed in as a plain host', () => {
    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [
          provideRouter(routes),
          provideHttpClient(),
          provideHttpClientTesting(),
          {
            provide: AuthService,
            useValue: { check: () => Promise.resolve(true), role: () => 'host' },
          },
        ],
      });
    });

    it('/admin sends a signed-in non-admin home rather than to /admin', async () => {
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl('/admin');
      expect(TestBed.inject(Router).url).toBe('/');
    });
  });

  describe('signed out', () => {
    beforeEach(() => configure(false));

    // The two screens a player may hold a link to must not demand a login they
    // have no way of passing.
    it('still shows the venue display', async () => {
      const harness = await RouterTestingHarness.create();
      expect(await harness.navigateByUrl('/s/xyz789/display', SessionDisplay)).toBeInstanceOf(
        SessionDisplay
      );
    });

    it('still shows a player stat card', async () => {
      const harness = await RouterTestingHarness.create();
      expect(await harness.navigateByUrl('/g/abc/p/p1', PlayerProfile)).toBeInstanceOf(
        PlayerProfile
      );
    });

    it('still shows the password reset page — a locked-out host has no cookie', async () => {
      const harness = await RouterTestingHarness.create();
      expect(await harness.navigateByUrl('/reset/some-token', ResetPassword)).toBeInstanceOf(
        ResetPassword
      );
    });

    it.each([
      ['/', 'the group list'],
      ['/g/abc123', 'a group'],
      ['/s/xyz789', 'a live session'],
    ])('redirects %s to the login page', async (url) => {
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl(url);
      expect(TestBed.inject(Router).url).toContain('/login');
    });

    it('carries the intended destination through to the login page', async () => {
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl('/s/xyz789');
      expect(TestBed.inject(Router).url).toContain('returnUrl=%2Fs%2Fxyz789');
    });
  });
});
