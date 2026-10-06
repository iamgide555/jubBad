import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { SessionSummary } from './session-summary';
import { AuthService } from '../../core/auth.service';
import { environment } from '../../../environments/environment';
import type { SessionSummary as Summary } from '../../core/session-summary.model';
import type { ShuttleInventory } from '../../core/shuttle.model';

const B = environment.apiBaseUrl;

// jsdom 28's HTMLDialogElement implements no showModal()/close() (an empty
// subclass — see jsdom's HTMLDialogElement-impl.js). This page now opens one
// (the host-only shuttle-edit dialog), so the shim is needed here too.
// Guarded so a future jsdom that implements them takes over.
beforeAll(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  }
});

function summary(overrides: Partial<Summary> = {}): Summary {
  return {
    session: {
      code: 'sess1',
      groupCode: 'group1',
      date: '2026-09-10',
      venue: 'ยิมกลาง',
      courtCount: 1,
      shuttleCount: null,
      shuttlePriceSatang: null,
      endedAt: '2026-09-10T20:00:00.000Z',
      courtLabels: [],
    },
    players: [
      {
        playerId: 'p1',
        name: 'ตั้ม',
        played: 2,
        won: 1,
        lost: 1,
        totalSeconds: 1200,
        distinctPartners: 0,
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
            durationSeconds: 720,
          },
          {
            matchNumber: 2,
            courtNumber: 1,
            partnerName: 'ปอม',
            opponentNames: ['เบส', 'เกีย'],
            scoreA: 18,
            scoreB: 21,
            result: 'loss',
            durationSeconds: 480,
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

  /** A host's ownership read on an ordinary session: disabled, empty, but 200 — proof of ownership. */
  const ORDINARY: ShuttleInventory = { enabled: false, identities: [], games: [], heldShuttleIds: [], lastShuttleByCourt: [] };

  /**
   * Loads the summary, then answers the owner-only inventory read that a
   * logged-in host triggers (an anonymous viewer makes none). `'denied'`
   * stands in for a logged-in host who does not own this session (a 404).
   */
  async function load(
    body: Summary | null,
    inventory: ShuttleInventory | 'denied' = ORDINARY,
    results: { pairingId: string; revision: number }[] = []
  ) {
    fixture.detectChanges();
    const req = httpMock.expectOne(`${B}/sessions/sess1/summary`);
    if (body) req.flush(body);
    else req.flush('Not Found', { status: 404, statusText: 'Not Found' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    for (const r of httpMock.match(`${B}/sessions/sess1/shuttles`)) {
      if (inventory === 'denied') r.flush('Not Found', { status: 404, statusText: 'Not Found' });
      else r.flush(inventory);
    }
    for (const r of httpMock.match(`${B}/sessions/sess1/results`)) {
      if (inventory === 'denied') r.flush('Not Found', { status: 404, statusText: 'Not Found' });
      else r.flush({ games: results });
    }
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
    expect(text).toContain('211');
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
            totalSeconds: 900,
            distinctPartners: 0,
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
                durationSeconds: 900,
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

  it('names each match\'s court by its latest label, even a court since removed, as literal text', async () => {
    const base = summary();
    await load(
      summary({
        session: { ...base.session, courtCount: 1, courtLabels: [null, null, '<b>A</b>'] },
        players: [
          {
            ...base.players[0],
            matches: [
              { ...base.players[0].matches[0], matchNumber: 1, courtNumber: 3 },
              { ...base.players[0].matches[0], matchNumber: 2, courtNumber: 1 },
            ],
          },
        ],
      })
    );
    fixture.componentInstance['togglePlayer'](base.players[0].playerId);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const items = [...el.querySelectorAll('.match-list li')].map((li) => li.textContent?.replace(/\s+/g, ' ') ?? '');
    expect(items[0]).toContain('คอร์ท <b>A</b>');
    expect(items[1]).toContain('คอร์ท 1');
    expect(el.querySelector('.match-list b')).toBeNull();
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
            totalSeconds: 5400,
            distinctPartners: 2,
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

  it('hides the distinct-partner count until the row is expanded, then shows it at the top of the match list', async () => {
    await load(
      summary({
        players: [
          {
            playerId: 'p1',
            name: 'ตั้ม',
            played: 3,
            won: 2,
            lost: 1,
            totalSeconds: 5400,
            distinctPartners: 3,
            singles: null,
            doubles: { played: 3, won: 2, lost: 1 },
            matches: [],
          },
        ],
      })
    );
    // Collapsed: the row-name cell must not carry the count — it pushed the
    // row taller and broke alignment with the other columns (owner report,
    // 2026-09-24).
    expect((fixture.nativeElement as HTMLElement).querySelector('.partner-variety')).toBeNull();

    fixture.componentInstance['togglePlayer']('p1');
    fixture.detectChanges();
    const cell = (fixture.nativeElement as HTMLElement).querySelector('.matches-row .partner-variety');
    expect(cell).not.toBeNull();
    expect(cell!.textContent).toContain('3');
  });

  it('hides the distinct-partner count for a player who only played singles this session', async () => {
    await load(summary());
    fixture.componentInstance['togglePlayer']('p1');
    fixture.detectChanges();
    // Default fixture player has doubles: null (never played doubles).
    const cell = (fixture.nativeElement as HTMLElement).querySelector('.partner-variety');
    expect(cell).toBeNull();
  });

  it('sorts by the tapped column instead of the server\'s played-descending order', async () => {
    await load(
      summary({
        players: [
          { playerId: 'p1', name: 'ตั้ม', played: 3, won: 1, lost: 2, totalSeconds: 100, distinctPartners: 0, singles: null, doubles: null, matches: [] },
          { playerId: 'p2', name: 'เบส', played: 2, won: 2, lost: 0, totalSeconds: 500, distinctPartners: 0, singles: null, doubles: null, matches: [] },
        ],
      })
    );
    // Default: played descending — p1 (3) before p2 (2).
    let names = [...(fixture.nativeElement as HTMLElement).querySelectorAll('.row-toggle')].map(
      (b) => b.textContent?.trim()
    );
    expect(names[0]).toContain('ตั้ม');

    fixture.componentInstance['setSortKey']('time');
    fixture.detectChanges();
    names = [...(fixture.nativeElement as HTMLElement).querySelectorAll('.row-toggle')].map(
      (b) => b.textContent?.trim()
    );
    // p2's totalSeconds (500) is higher than p1's (100).
    expect(names[0]).toContain('เบส');
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

  it('shows the total play time and average game length for a player', async () => {
    await load(summary());
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    // totalSeconds: 1200 (20 min) across 2 matches -> average 600s (10 min).
    expect(text).toContain('20 น.');
    expect(text).toContain('10 น.');
  });

  it('shows each match\'s own duration in the expanded list', async () => {
    await load(summary());
    fixture.componentInstance['togglePlayer']('p1');
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    // durationSeconds: 720 (12 min) and 480 (8 min).
    expect(text).toContain('12 น.');
    expect(text).toContain('8 น.');
  });

  it('still shows a duration for a match with no result', async () => {
    await load(
      summary({
        players: [
          {
            playerId: 'p1',
            name: 'ตั้ม',
            played: 1,
            won: 0,
            lost: 0,
            totalSeconds: 600,
            distinctPartners: 0,
            singles: null,
            doubles: null,
            matches: [
              {
                matchNumber: 1,
                courtNumber: 1,
                partnerName: 'เบส',
                opponentNames: ['ปอม', 'เกีย'],
                scoreA: null,
                scoreB: null,
                result: 'no-result',
                durationSeconds: 600,
              },
            ],
          },
        ],
      })
    );
    fixture.componentInstance['togglePlayer']('p1');
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('ไม่มีผล');
    expect(text).toContain('10 น.');
  });

  describe('shuttle count/price section', () => {
    it('hides the section entirely when both fields are unset', async () => {
      await load(summary({ session: { ...summary().session, shuttleCount: null, shuttlePriceSatang: null } }));
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('.shuttle-summary')).toBeNull();
    });

    it('shows both values when both fields are set', async () => {
      await load(
        summary({ session: { ...summary().session, shuttleCount: 12, shuttlePriceSatang: 8050 } })
      );
      const text = (fixture.nativeElement as HTMLElement).querySelector('.shuttle-summary')?.textContent ?? '';
      expect(text).toContain('12 ลูก');
      expect(text).toContain('80.50 บาท/ลูก');
      expect(text).not.toContain('ยังไม่ได้บันทึก');
    });

    it('labels the price as not recorded when only the count is set', async () => {
      await load(
        summary({ session: { ...summary().session, shuttleCount: 12, shuttlePriceSatang: null } })
      );
      const text = (fixture.nativeElement as HTMLElement).querySelector('.shuttle-summary')?.textContent ?? '';
      expect(text).toContain('12 ลูก');
      expect(text).toContain('ยังไม่ได้บันทึก');
    });

    it('labels the count as not recorded when only the price is set', async () => {
      await load(
        summary({ session: { ...summary().session, shuttleCount: null, shuttlePriceSatang: 8050 } })
      );
      const text = (fixture.nativeElement as HTMLElement).querySelector('.shuttle-summary')?.textContent ?? '';
      expect(text).toContain('80.50 บาท/ลูก');
      expect(text).toContain('ยังไม่ได้บันทึก');
    });
  });

  it('shows no shuttle-edit button for a non-host viewer', async () => {
    await load(summary());
    expect((fixture.nativeElement as HTMLElement).querySelector('.shuttle-edit')).toBeNull();
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

    describe('shuttle-edit button and dialog', () => {
      function editButton(): HTMLButtonElement | null {
        return (fixture.nativeElement as HTMLElement).querySelector('.shuttle-edit button');
      }

      function dialogInputs() {
        const el = fixture.nativeElement as HTMLElement;
        return {
          count: el.querySelector('input[name="shuttleCount"]') as HTMLInputElement | null,
          price: el.querySelector('input[name="shuttlePrice"]') as HTMLInputElement | null,
        };
      }

      function type(input: HTMLInputElement, value: string) {
        input.value = value;
        input.dispatchEvent(new Event('input'));
        fixture.detectChanges();
      }

      /** NgModel defers its initial DOM write to a microtask on a freshly-mounted control. */
      async function openDialog(): Promise<void> {
        editButton()!.click();
        fixture.detectChanges();
        await Promise.resolve();
        fixture.detectChanges();
      }

      function confirmButton(): HTMLButtonElement {
        return Array.from(
          (fixture.nativeElement as HTMLElement).querySelectorAll('button')
        ).find((b) => b.closest('dialog') && b.textContent?.includes('บันทึก')) as HTMLButtonElement;
      }

      it('shows the edit button even when nothing is recorded yet, labeled to record', async () => {
        await load(
          summary({ session: { ...summary().session, shuttleCount: null, shuttlePriceSatang: null } })
        );
        expect(editButton()).not.toBeNull();
        expect(editButton()!.textContent).toContain('บันทึกลูกแบด');
      });

      it('labels the edit button to edit once something is recorded', async () => {
        await load(
          summary({ session: { ...summary().session, shuttleCount: 12, shuttlePriceSatang: null } })
        );
        expect(editButton()!.textContent).toContain('แก้ไขลูกแบด');
      });

      it('opens the dialog prefilled with the committed values', async () => {
        await load(
          summary({ session: { ...summary().session, shuttleCount: 12, shuttlePriceSatang: 8050 } })
        );
        await openDialog();
        const { count, price } = dialogInputs();
        expect(count!.value).toBe('12');
        expect(price!.value).toBe('80.50');
      });

      it('confirming a change POSTs the patch and reloads the summary', async () => {
        await load(
          summary({ session: { ...summary().session, shuttleCount: 5, shuttlePriceSatang: null } })
        );
        await openDialog();
        type(dialogInputs().count!, '9');

        confirmButton().click();

        const req = httpMock.expectOne(`${B}/sessions/sess1/shuttle-details`);
        expect(req.request.body).toEqual({ shuttleCount: 9 });
        req.flush({ code: 'sess1', shuttleCount: 9, shuttlePriceSatang: null });

        await new Promise((r) => setTimeout(r, 0));
        fixture.detectChanges();
        httpMock
          .expectOne(`${B}/sessions/sess1/summary`)
          .flush(summary({ session: { ...summary().session, shuttleCount: 9, shuttlePriceSatang: null } }));
        await new Promise((r) => setTimeout(r, 0));
        fixture.detectChanges();

        const text =
          (fixture.nativeElement as HTMLElement).querySelector('.shuttle-summary')?.textContent ?? '';
        expect(text).toContain('9 ลูก');
      });

      it('confirming untouched closes the dialog without any POST', async () => {
        await load(
          summary({ session: { ...summary().session, shuttleCount: 5, shuttlePriceSatang: null } })
        );
        await openDialog();

        confirmButton().click();
        fixture.detectChanges();

        httpMock.expectNone(`${B}/sessions/sess1/shuttle-details`);
        expect(dialogInputs().count).toBeNull();
      });

      it('a failed save keeps the dialog open with an error, without reloading the summary', async () => {
        await load(
          summary({ session: { ...summary().session, shuttleCount: 5, shuttlePriceSatang: null } })
        );
        await openDialog();
        type(dialogInputs().count!, '9');

        confirmButton().click();
        httpMock
          .expectOne(`${B}/sessions/sess1/shuttle-details`)
          .flush('error', { status: 500, statusText: 'Server Error' });
        await new Promise((r) => setTimeout(r, 0));
        fixture.detectChanges();

        httpMock.expectNone(`${B}/sessions/sess1/summary`);
        expect((fixture.nativeElement as HTMLElement).textContent).toContain(
          'บันทึกข้อมูลลูกแบดไม่สำเร็จ'
        );
        expect(dialogInputs().count).not.toBeNull();
      });
    });
  });

  describe('shuttle log and corrections (advanced sessions)', () => {
    const ref = (n: number) => ({ id: `s${n}`, number: n });
    const advanced = (
      log: { pairingId: string; courtNumber: number; matchNumber: number; shuttles: { id: string; number: number }[] | null; teamA?: string[]; teamB?: string[] }[],
      accounting: { recordedFinishedShuttles: number; unknownFinishedMatches: number; finishedMatches: number },
      physical: number | null = null,
      endedAt: string | null = '2026-09-10T20:00:00.000Z'
    ): Summary =>
      summary({ session: { ...summary().session, shuttleCount: physical, endedAt }, shuttleLog: log.map((r) => ({ teamA: ['นก', 'เจ'], teamB: ['ต้น', 'แมน'], ...r })), shuttleAccounting: accounting });
    const twoGames = () =>
      advanced(
        [
          { pairingId: 'g1', courtNumber: 1, matchNumber: 1, shuttles: [ref(1)] },
          { pairingId: 'g2', courtNumber: 1, matchNumber: 2, shuttles: [ref(1)] },
        ],
        { recordedFinishedShuttles: 1, unknownFinishedMatches: 0, finishedMatches: 2 }
      );
    const inventory = (over: Partial<ShuttleInventory> = {}): ShuttleInventory => ({
      enabled: true,
      identities: [
        { id: 's1', number: 1, usable: true, voided: false },
        { id: 's2', number: 2, usable: false, voided: false },
        { id: 's3', number: 3, usable: true, voided: true },
      ],
      games: [
        { pairingId: 'g1', revision: 5, shuttleIds: ['s1'] },
        { pairingId: 'g2', revision: 6, shuttleIds: ['s1'] },
      ],
      heldShuttleIds: [],
      lastShuttleByCourt: [],
      ...over,
    });
    const el = () => fixture.nativeElement as HTMLElement;
    const text = () => el().textContent ?? '';
    const logRows = () => [...el().querySelectorAll('.shuttle-log li')] as HTMLElement[];
    const editRow = (n: number) => el().querySelectorAll('[data-edit-shuttle-log]')[n] as HTMLButtonElement | undefined;
    const dialog = () => el().querySelector('dialog.shuttle-correction-dialog') as HTMLDialogElement;

    describe('for a public viewer', () => {
      beforeEach(() => configure(false));

      it('lists one row per finished game with its numbered shuttles', async () => {
        await load(twoGames());
        expect(logRows()).toHaveLength(2);
        expect(logRows()[0].textContent).toContain('#1');
        expect(logRows()[0].textContent).toContain('1');
      });

      it('counts a shuttle reused across games once in the distinct total', async () => {
        await load(twoGames());
        expect(el().querySelector('.shuttle-log-section > summary')!.textContent).toContain('1 ลูก');
        expect(el().querySelector('.shuttle-log-section > summary')!.textContent).not.toContain('2 ลูก');
      });

      it('tells unknown apart from recorded-as-none', async () => {
        await load(
          advanced(
            [
              { pairingId: 'g1', courtNumber: 1, matchNumber: 1, shuttles: null },
              { pairingId: 'g2', courtNumber: 1, matchNumber: 2, shuttles: [] },
            ],
            { recordedFinishedShuttles: 0, unknownFinishedMatches: 1, finishedMatches: 2 }
          )
        );
        expect(logRows()[0].textContent).toContain('ไม่ทราบ');
        expect(logRows()[1].textContent).toContain('ไม่ได้ใช้ลูกแบด');
      });

      it('labels the subtotal partial while some finished game is unknown', async () => {
        await load(advanced([{ pairingId: 'g1', courtNumber: 1, matchNumber: 1, shuttles: null }], { recordedFinishedShuttles: 0, unknownFinishedMatches: 1, finishedMatches: 1 }));
        expect(el().querySelector('.shuttle-accounting')!.textContent).toContain('ไม่ครบ');
      });

      it('shows the physical count separately and a difference only when every game is recorded', async () => {
        await load(advanced(twoGames().shuttleLog!, { recordedFinishedShuttles: 1, unknownFinishedMatches: 0, finishedMatches: 2 }, 4));
        const acc = el().querySelector('.shuttle-accounting')!.textContent ?? '';
        expect(acc).toContain('นับจริง');
        expect(acc).toContain('+3');
      });

      it('hides the difference while a game is unknown, and when no game has finished', async () => {
        await load(advanced([{ pairingId: 'g1', courtNumber: 1, matchNumber: 1, shuttles: null }], { recordedFinishedShuttles: 0, unknownFinishedMatches: 1, finishedMatches: 1 }, 4));
        expect(el().querySelector('.shuttle-accounting')!.textContent).not.toContain('+4');
      });

      it('is read-only: no correction buttons, dialog, or physical editor', async () => {
        await load(twoGames());
        expect(editRow(0)).toBeUndefined();
        expect(dialog()).toBeNull();
        expect(el().querySelector('.shuttle-edit')).toBeNull();
      });

      it('an ordinary session\'s summary has no log section at all', async () => {
        await load(summary());
        expect(el().querySelector('.shuttle-log')).toBeNull();
        expect(el().querySelector('.shuttle-accounting')).toBeNull();
      });

      it('uses the court\'s label, including for a court removed before the end', async () => {
        const s = twoGames();
        s.session.courtLabels = ['ริมหน้าต่าง'];
        await load(s);
        expect(logRows()[0].textContent).toContain('ริมหน้าต่าง');
      });
    });

    describe('for a logged-in host who does not own the session', () => {
      beforeEach(() => configure(true));

      it('sees no editor, corrections, or bill link — only the public log', async () => {
        await load(twoGames(), 'denied');
        expect(logRows()).toHaveLength(2);
        expect(editRow(0)).toBeUndefined();
        expect(el().querySelector('.shuttle-edit')).toBeNull();
      });
    });

    describe('for the owning host', () => {
      beforeEach(() => configure(true));

      it('gets a correction button on every finished game, even after the session ended', async () => {
        await load(twoGames(), inventory());
        expect(el().querySelectorAll('[data-edit-shuttle-log]')).toHaveLength(2);
      });

      it('labels the physical editor so it is not mistaken for per-game tracking', async () => {
        await load(twoGames(), inventory());
        const button = el().querySelector('.shuttle-edit button') as HTMLButtonElement;
        expect(button.textContent).toContain('นับจริง');
      });

      it('corrects a game: sends the revision it read, then refreshes the summary and the inventory', async () => {
        await load(twoGames(), inventory());
        editRow(1)!.click();
        fixture.detectChanges();
        await Promise.resolve();
        fixture.detectChanges();
        expect(dialog().hasAttribute('open')).toBe(true);
        // Voided identities are never offered; retired ones are.
        expect(dialog().querySelector('[data-shuttle-chip="s3"]')).toBeNull();
        (dialog().querySelector('[data-shuttle-chip="s2"]') as HTMLButtonElement).click();
        fixture.detectChanges();
        (dialog().querySelector('[data-save-correction]') as HTMLButtonElement).click();

        const req = httpMock.expectOne(`${B}/sessions/sess1/pairings/g2/shuttles/correct`);
        expect(req.request.body).toEqual({ shuttleIds: ['s1', 's2'], openNew: false, expectedRevision: 6 });
        req.flush({});
        await new Promise((r) => setTimeout(r, 0));
        TestBed.tick();
        const next = twoGames();
        next.shuttleLog![1].shuttles = [ref(1), ref(2)];
        next.shuttleAccounting!.recordedFinishedShuttles = 2;
        httpMock.expectOne(`${B}/sessions/sess1/summary`).flush(next);
        httpMock.expectOne(`${B}/sessions/sess1/shuttles`).flush(inventory({ games: [{ pairingId: 'g1', revision: 5, shuttleIds: ['s1'] }, { pairingId: 'g2', revision: 7, shuttleIds: ['s1', 's2'] }] }));
        for (const r of httpMock.match(`${B}/sessions/sess1/results`)) r.flush({ games: [] });
        await new Promise((r) => setTimeout(r, 0));
        TestBed.tick();
        fixture.detectChanges();
        expect(dialog().hasAttribute('open')).toBe(false);
        expect(logRows()[1].textContent).toContain('#2');
        expect(el().querySelector('.shuttle-log-section > summary')!.textContent).toContain('2 ลูก');
      });

      it('shows a stale correction as a localized error, keeps the dialog, and re-reads the truth', async () => {
        await load(twoGames(), inventory());
        editRow(0)!.click();
        fixture.detectChanges();
        await Promise.resolve();
        fixture.detectChanges();
        (dialog().querySelector('[data-save-correction]') as HTMLButtonElement).click();
        httpMock
          .expectOne(`${B}/sessions/sess1/pairings/g1/shuttles/correct`)
          .flush({ code: 'PAIRING_STALE' }, { status: 409, statusText: 'Conflict' });
        await new Promise((r) => setTimeout(r, 0));
        TestBed.tick();
        httpMock.expectOne(`${B}/sessions/sess1/summary`).flush(twoGames());
        httpMock.expectOne(`${B}/sessions/sess1/shuttles`).flush(inventory());
        for (const r of httpMock.match(`${B}/sessions/sess1/results`)) r.flush({ games: [] });
        await new Promise((r) => setTimeout(r, 0));
        TestBed.tick();
        fixture.detectChanges();
        expect(dialog().hasAttribute('open')).toBe(true);
        expect(dialog().querySelector('[role="alert"]')!.textContent).toContain('อุปกรณ์อื่น');
      });

      it('an ordinary session\'s owner keeps the physical-count editor but has no log or correction', async () => {
        await load(summary(), ORDINARY);
        expect(el().querySelector('.shuttle-edit')).not.toBeNull();
        expect(el().querySelector('.shuttle-log')).toBeNull();
        expect(editRow(0)).toBeUndefined();
      });
    });
  });
});
