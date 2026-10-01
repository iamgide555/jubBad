import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { GroupDashboard } from './group-dashboard';
import { environment } from '../../../environments/environment';
import type { Dashboard } from '../../core/dashboard.model';

const B = environment.apiBaseUrl;

function dashboard(over: Partial<Dashboard> = {}): Dashboard {
  return {
    groupName: 'ก๊วนวันพฤหัส',
    lastSessionDate: '2026-09-24',
    sessions: [
      { code: 'live1', date: '2026-10-01', createdAt: '2026-10-01T10:00:00.000Z', venue: 'ยิมกลาง', playerCount: 8, matchCount: 3, live: true },
      { code: 'old1', date: '2026-09-24', createdAt: '2026-09-24T10:00:00.000Z', venue: null, playerCount: 12, matchCount: 9, live: false },
      { code: 'nodate', date: null, createdAt: '2026-09-17T10:00:00.000Z', venue: null, playerCount: 4, matchCount: 2, live: false },
    ],
    standings: [
      { name: 'ตั้ม', sessionsAttended: 3, gamesPlayed: 14 },
      { name: 'เบส', sessionsAttended: 2, gamesPlayed: 9 },
    ],
    ...over,
  };
}

describe('GroupDashboard', () => {
  let fixture: ComponentFixture<GroupDashboard>;
  let httpMock: HttpTestingController;

  async function load(body: Dashboard | null) {
    await TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ token: 'tok1' }) } } },
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(GroupDashboard);
    fixture.detectChanges();
    const req = httpMock.expectOne(`${B}/dashboards/tok1`);
    if (body) req.flush(body);
    else req.flush('Not Found', { status: 404, statusText: 'Not Found' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    fixture.detectChanges();
  }

  afterEach(() => httpMock.verify());

  const el = () => fixture.nativeElement as HTMLElement;
  const hrefs = () => Array.from(el().querySelectorAll('a')).map((a) => a.getAttribute('href'));

  it('shows the group name and the last session date', async () => {
    await load(dashboard());
    expect(el().querySelector('h1')?.textContent).toContain('ก๊วนวันพฤหัส');
    expect(el().textContent).toContain('2026-09-24');
  });

  it('links each past session to its existing summary page', async () => {
    await load(dashboard());
    expect(hrefs()).toContain('/s/old1/summary');
    expect(hrefs()).toContain('/s/nodate/summary');
  });

  it('marks a live session and links it to the public venue display', async () => {
    await load(dashboard());
    expect(hrefs()).toContain('/s/live1/display');
    expect(el().querySelectorAll('.live-tag')).toHaveLength(1);
  });

  it('falls back to the created date when a session has no date', async () => {
    await load(dashboard());
    expect(el().textContent).toContain('2026-09-17');
  });

  it('lists standings in the order the server sent, with plain-text names', async () => {
    await load(dashboard());
    const rows = Array.from(el().querySelectorAll('tbody tr')).map((r) => r.textContent ?? '');
    expect(rows[0]).toContain('ตั้ม');
    expect(rows[1]).toContain('เบส');
    // Names are not links: this page must never lead to a player card.
    expect(hrefs().some((h) => h?.includes('/p/'))).toBe(false);
    expect(hrefs().some((h) => h?.startsWith('/g/'))).toBe(false);
  });

  it('shows an empty state when the group has never played', async () => {
    await load(dashboard({ sessions: [], standings: [], lastSessionDate: null }));
    expect(el().querySelector('.empty')).not.toBeNull();
    expect(el().querySelector('table')).toBeNull();
  });

  it('says the link is unavailable on a 404, without revealing why', async () => {
    await load(null);
    expect(el().querySelector('.not-found')).not.toBeNull();
    expect(el().querySelector('.group-dashboard')).toBeNull();
  });
});
