import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from './app.routes';
import { GroupEntry } from './pages/group-entry/group-entry';
import { SessionDashboard } from './pages/session-dashboard/session-dashboard';
import { SessionDisplay } from './pages/session-display/session-display';
import { Landing } from './pages/landing/landing';

describe('app routes', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter(routes)],
    });
  });

  it('/ resolves to Landing', async () => {
    const harness = await RouterTestingHarness.create();
    const component = await harness.navigateByUrl('/', Landing);
    expect(component).toBeInstanceOf(Landing);
  });

  it('/g/:groupCode resolves to GroupEntry', async () => {
    const harness = await RouterTestingHarness.create();
    const component = await harness.navigateByUrl('/g/abc123', GroupEntry);
    expect(component).toBeInstanceOf(GroupEntry);
  });

  it('/s/:sessionCode resolves to SessionDashboard', async () => {
    const harness = await RouterTestingHarness.create();
    const component = await harness.navigateByUrl(
      '/s/xyz789',
      SessionDashboard
    );
    expect(component).toBeInstanceOf(SessionDashboard);
  });

  it('/s/:sessionCode/display resolves to SessionDisplay', async () => {
    const harness = await RouterTestingHarness.create();
    const component = await harness.navigateByUrl(
      '/s/xyz789/display',
      SessionDisplay
    );
    expect(component).toBeInstanceOf(SessionDisplay);
  });
});
