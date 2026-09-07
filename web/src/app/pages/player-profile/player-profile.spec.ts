import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { PlayerProfile } from './player-profile';
import { AuthService } from '../../core/auth.service';
import { environment } from '../../../environments/environment';
import type { PlayerProfile as Profile } from '../../core/player-stats.model';

const B = environment.apiBaseUrl;

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    playerId: 'p1',
    name: 'ตั้ม',
    played: 3,
    won: 2,
    winRate: 2 / 3,
    rating: 1215,
    mostWinsWith: { playerId: 'p2', name: 'เบส', played: 2, won: 2 },
    mostFacedOpponent: { playerId: 'p3', name: 'ปอม', played: 3, won: 1 },
    ...overrides,
  };
}

describe('PlayerProfile', () => {
  let fixture: ComponentFixture<PlayerProfile>;
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PlayerProfile],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),

        // The page asks whether the visitor is signed in, to decide whether the

        // back link (which points at an admin-only screen) is worth showing.

        { provide: AuthService, useValue: { check: () => Promise.resolve(false) } },
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: convertToParamMap({ groupCode: 'group1', playerId: 'p1' }) },
          },
        },
      ],
    }).compileComponents();

    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(PlayerProfile);
  });

  afterEach(() => httpMock.verify());

  async function load(body: Profile | null) {
    fixture.detectChanges();
    const req = httpMock.expectOne(`${B}/groups/group1/players/p1/stats`);
    if (body) req.flush(body);
    else req.flush('Not Found', { status: 404, statusText: 'Not Found' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    fixture.detectChanges();
  }

  it('shows the record, best partner and most-faced opponent', async () => {
    await load(profile());
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('ตั้ม');
    expect(text).toContain('เบส');
    expect(text).toContain('ปอม');
    expect(text).toContain('1215');
  });

  it('renders the win rate as a whole percent', async () => {
    await load(profile());
    expect(fixture.componentInstance['winPercent']()).toBe(67);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('67%');
  });

  it('shows a dash rather than 0% for someone who has never played', async () => {
    await load(profile({ played: 0, won: 0, winRate: null, mostWinsWith: null, mostFacedOpponent: null }));
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(fixture.componentInstance['winPercent']()).toBeNull();
    expect(text).not.toContain('0%');
    expect(text).toContain('ยังไม่ได้ลงเล่น');
  });

  it('shows a not-found message when the player is unknown', async () => {
    await load(null);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('ไม่พบผู้เล่น');
  });
});
