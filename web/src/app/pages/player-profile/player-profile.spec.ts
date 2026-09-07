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
    bestPartner: { playerId: 'p2', name: 'เบส', played: 8, won: 6, winRate: 0.75, provisional: false },
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
    await load(profile({ played: 0, won: 0, winRate: null, bestPartner: null, mostFacedOpponent: null }));
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(fixture.componentInstance['winPercent']()).toBeNull();
    expect(text).not.toContain('0%');
    expect(text).toContain('ยังไม่ได้ลงเล่น');
  });

  it('shows a not-found message when the player is unknown', async () => {
    await load(null);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('ไม่พบผู้เล่น');
  });

  it('shows the partner win rate once the pairing has enough games', async () => {
    await load(profile());
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('คู่ที่ดีที่สุด');
    expect(text).toContain('75%');
    expect(text).toContain('6/8');
  });

  it('labels a below-the-floor partner as a count, not a rate', async () => {
    // Guards the honesty of the panel: with 2 of 3 games the heading must not
    // claim "best partner" or print a 67% that reads as a measured rate.
    await load(
      profile({
        // Own rate held distinct from the partner's so the assertion below
        // cannot pass by reading the player's own percentage.
        played: 4,
        won: 2,
        winRate: 0.5,
        bestPartner: {
          playerId: 'p2',
          name: 'เบส',
          played: 3,
          won: 2,
          winRate: 2 / 3,
          provisional: true,
        },
      })
    );
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('ชนะด้วยกันมากที่สุด');
    expect(text).not.toContain('คู่ที่ดีที่สุด');
    expect(text).not.toContain('67%');
    expect(text).toContain('ยังเล่นด้วยกันไม่ถึง 5 เกม');
  });
});
