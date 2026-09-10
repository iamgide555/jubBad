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

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SessionSummary],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { check: () => Promise.resolve(false) } },
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
  });

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
});
