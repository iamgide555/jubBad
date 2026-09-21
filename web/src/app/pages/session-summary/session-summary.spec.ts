import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { SessionSummary } from './session-summary';
import { AuthService } from '../../core/auth.service';
import { environment } from '../../../environments/environment';
import type { SessionSummary as Summary } from '../../core/session-summary.model';

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
    },
    players: [
      {
        playerId: 'p1',
        name: 'ตั้ม',
        played: 2,
        won: 1,
        lost: 1,
        totalSeconds: 1200,
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
            totalSeconds: 900,
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

  it('expanded match-list row spans all 8 columns — no profile column for a non-host viewer', async () => {
    await load(summary());
    fixture.componentInstance['togglePlayer']('p1');
    fixture.detectChanges();
    const cell = (fixture.nativeElement as HTMLElement).querySelector('.matches-row td')!;
    expect(cell.getAttribute('colspan')).toBe('8');
  });

  it('does not show the profile column at all', async () => {
    await load(summary());
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.profile-cell')).toBeNull();
    expect(el.querySelectorAll('th').length).toBe(8);
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

    it('expanded match-list row spans all 9 columns, including the profile column', async () => {
      await load(summary());
      fixture.componentInstance['togglePlayer']('p1');
      fixture.detectChanges();
      const cell = (fixture.nativeElement as HTMLElement).querySelector('.matches-row td')!;
      expect(cell.getAttribute('colspan')).toBe('9');
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
});
