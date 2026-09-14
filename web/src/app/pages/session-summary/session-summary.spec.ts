import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { SessionSummary } from './session-summary';
import { AuthService } from '../../core/auth.service';
import { environment } from '../../../environments/environment';
import type { SessionSummary as Summary } from '../../core/session-summary.model';

const B = environment.apiBaseUrl;

function summary(overrides: Partial<Summary> = {}): Summary {
  return {
    session: {
      code: 'sess1',
      groupCode: 'group1',
      date: '2026-09-10',
      venue: 'ยิมกลาง',
      courtCount: 1,
      endedAt: '2026-09-10T20:00:00.000Z',
    },
    players: [
      {
        playerId: 'p1',
        name: 'ตั้ม',
        played: 2,
        won: 1,
        lost: 1,
        singles: null,
        doubles: null,
        matches: [
          {
            matchNumber: 1,
            courtNumber: 1,
            partnerName: 'เบส',
            opponentNames: ['ปอม', 'เกีย'],
            scoreA: 21,
            scoreB: 15,
            result: 'win',
          },
          {
            matchNumber: 2,
            courtNumber: 1,
            partnerName: 'ปอม',
            opponentNames: ['เบส', 'เกีย'],
            scoreA: 18,
            scoreB: 21,
            result: 'loss',
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('SessionSummary', () => {
  let fixture: ComponentFixture<SessionSummary>;
  let httpMock: HttpTestingController;

  async function configure(isHost: boolean): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [SessionSummary],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { check: () => Promise.resolve(isHost) } },
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: convertToParamMap({ sessionCode: 'sess1' }) },
          },
        },
      ],
    }).compileComponents();

    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(SessionSummary);
  }

  afterEach(() => httpMock.verify());

  async function load(body: Summary | null) {
    fixture.detectChanges();
    const req = httpMock.expectOne(`${B}/sessions/sess1/summary`);
    if (body) req.flush(body);
    else req.flush('Not Found', { status: 404, statusText: 'Not Found' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    fixture.detectChanges();
  }

  describe('as a non-host viewer (default)', () => {
  beforeEach(() => configure(false));

  it('shows the session header and per-player record', async () => {
    await load(summary());
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('ยิมกลาง');
    expect(text).toContain('ตั้ม');
    expect(text).toContain('50%');
  });

  it('does not show a player match list until their row is tapped', async () => {
    await load(summary());
    let text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).not.toContain('เกีย');

    fixture.componentInstance['togglePlayer']('p1');
    fixture.detectChanges();
    text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('เกีย');
    expect(text).toContain('21-15');
  });

  it('shows no partner clause for a singles match, and lists its one opponent', async () => {
    await load(
      summary({
        players: [
          {
            playerId: 'p1',
            name: 'ตั้ม',
            played: 1,
            won: 1,
            lost: 0,
            singles: null,
            doubles: null,
            matches: [
              {
                matchNumber: 1,
                courtNumber: 2,
                partnerName: null,
                opponentNames: ['เบส'],
                scoreA: 21,
                scoreB: 15,
                result: 'win',
              },
            ],
          },
        ],
      })
    );
    fixture.componentInstance['togglePlayer']('p1');
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('เดี่ยว');
    expect(text).toContain('เบส');
    expect(text).not.toContain('กับ');
  });

  it('shows separate singles/doubles win-rate columns with the games played', async () => {
    await load(
      summary({
        players: [
          {
            playerId: 'p1',
            name: 'ตั้ม',
            played: 3,
            won: 2,
            lost: 1,
            singles: { played: 1, won: 0, lost: 1 },
            doubles: { played: 2, won: 2, lost: 0 },
            matches: [],
          },
        ],
      })
    );
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('100%');
    expect(text).toContain('2 เกม');
    expect(text).toContain('0%');
    expect(text).toContain('1 เกม');
  });

  it('shows a dash for the format a player has never played', async () => {
    await load(summary());
    const cells = [...(fixture.nativeElement as HTMLElement).querySelectorAll('td')].map(
      (el) => el.textContent?.trim()
    );
    // p1 in the default fixture has no singles/doubles breakdown at all.
    expect(cells.filter((c) => c === '–').length).toBeGreaterThanOrEqual(2);
  });

  it('collapses an already-expanded row on a second tap', async () => {
    await load(summary());
    fixture.componentInstance['togglePlayer']('p1');
    fixture.componentInstance['togglePlayer']('p1');
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent ?? '').not.toContain('เกีย');
  });

  it('shows a not-found message when the session is unknown', async () => {
    await load(null);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('ไม่พบก๊วนนี้');
  });

  it('shows an empty-state message when no matches were played', async () => {
    await load(summary({ players: [] }));
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'ก๊วนนี้ยังไม่มีการแข่งขัน'
    );
  });

  it('expanded match-list row spans all 7 columns — no profile column for a non-host viewer', async () => {
    await load(summary());
    fixture.componentInstance['togglePlayer']('p1');
    fixture.detectChanges();
    const cell = (fixture.nativeElement as HTMLElement).querySelector('.matches-row td')!;
    expect(cell.getAttribute('colspan')).toBe('7');
  });

  it('does not show the profile column at all', async () => {
    await load(summary());
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.profile-cell')).toBeNull();
    expect(el.querySelectorAll('th').length).toBe(7);
  });
  });

  describe('as the authed host', () => {
    beforeEach(() => configure(true));

    it('shows the profile column with an enabled copy-link button', async () => {
      await load(summary());
      const btn = (fixture.nativeElement as HTMLElement).querySelector(
        '.profile-cell button'
      ) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });

    it('expanded match-list row spans all 8 columns, including the profile column', async () => {
      await load(summary());
      fixture.componentInstance['togglePlayer']('p1');
      fixture.detectChanges();
      const cell = (fixture.nativeElement as HTMLElement).querySelector('.matches-row td')!;
      expect(cell.getAttribute('colspan')).toBe('8');
    });

    it('copies the player profile URL when the profile button is tapped', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });
      await load(summary());
      const btn = (fixture.nativeElement as HTMLElement).querySelector(
        '.profile-cell button'
      ) as HTMLButtonElement;
      btn.click();
      await new Promise((r) => setTimeout(r, 0));
      expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/g\/group1\/p\/p1$/));
    });
  });
});
