import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { SessionBill } from './session-bill';
import { environment } from '../../../environments/environment';
import type { BillResponse } from '../../core/bill.model';

const B = environment.apiBaseUrl;

function response(): BillResponse {
  return {
    session: { code: 'sess1', date: null, venue: null, endedAt: null, shuttleCount: 0, shuttlePriceSatang: 0, shuttleToolsEnabled: false },
    config: {
      model: 'fair', courtFeeSatang: 20000, courtSplit: 'equal', shuttleSplit: 'byGames', perGameRateSatang: 0,
      entryFeeSatang: 0, capSatang: null, buffetPriceSatang: 0, buffetShuttlesIncluded: true, startingFeeSatang: 0, hostFeeSatang: 0,
      walkInFeeSatang: 2000, roundingBaht: 1, addedIds: [], removedIds: [], overrides: [],
    },
    configSource: 'saved',
    players: [
      { playerId: 'a', name: 'Amp', games: 1, walkIn: false },
      { playerId: 'd', name: 'Dee', games: 1, walkIn: true },
      { playerId: 'z', name: 'Zed', games: 0, walkIn: false },
    ],
    settled: [],
    result: {
      rows: [
        { playerId: 'a', games: 1, status: 'billed', added: false, walkIn: false, courtSatang: 10000, shuttleSatang: 0,
          baseSatang: 10000, hostFeeSatang: 0, walkInFeeSatang: 0, walkInDiscountSatang: 1000, overridden: false, amountSatang: 9000 },
        { playerId: 'd', games: 1, status: 'billed', added: false, walkIn: true, courtSatang: 10000, shuttleSatang: 0,
          baseSatang: 10000, hostFeeSatang: 0, walkInFeeSatang: 2000, walkInDiscountSatang: 1000, overridden: false, amountSatang: 11000 },
      ],
      totals: { settledTotalSatang: 0, stillDueSatang: 0, excessCreditSatang: 0, uncoveredCostSatang: 0, unreturnedSurchargeSatang: 0, collectedSatang: 20000, costSatang: 20000, marginSatang: 0, billedCount: 2, walkInCount: 1 },
      warnings: [],
    },
    accounting: { recordedFinishedShuttles: 0, unknownFinishedMatches: 0, finishedMatches: 0, physicalCount: 0, effectiveCount: 0, source: 'ordinary', allocation: 'legacy-basic' },
    readyToCopy: true,
  };
}

describe('SessionBill', () => {
  let fixture: ComponentFixture<SessionBill>;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SessionBill],
      providers: [
        provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ sessionCode: 'sess1' }) } } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(SessionBill);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  async function load(body = response()) {
    fixture.detectChanges();
    http.expectOne(`${B}/sessions/sess1/bill`).flush(body);
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
  }

  it('renders billed rows with amounts and the walk-in mark', async () => {
    await load();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Amp');
    expect(text).toContain('90');
    expect(text).toContain('110');
    const chip = fixture.nativeElement.querySelector('[data-walk-in="d"]') as HTMLButtonElement;
    expect(chip.getAttribute('aria-pressed')).toBe('true');
  });

  it('switching model posts the full config with the new model', async () => {
    await load();
    (fixture.nativeElement.querySelector('[data-model="buffet"]') as HTMLButtonElement).click();
    const req = http.expectOne(`${B}/sessions/sess1/bill-config`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body.model).toBe('buffet');
    expect(req.request.body.walkInFeeSatang).toBe(2000);
    req.flush(response());
  });

  it('toggling walk-in posts to the roster route then reloads the bill', async () => {
    await load();
    (fixture.nativeElement.querySelector('[data-walk-in="a"]') as HTMLButtonElement).click();
    const req = http.expectOne(`${B}/sessions/sess1/roster/a/walk-in`);
    expect(req.request.body).toEqual({ walkIn: true });
    req.flush({ playerId: 'a', walkIn: true });
    await new Promise((r) => setTimeout(r, 0));
    http.expectOne(`${B}/sessions/sess1/bill`).flush(response());
  });

  it('adding a roster player with no games posts addedIds', async () => {
    await load();
    (fixture.nativeElement.querySelector('[data-add="z"]') as HTMLButtonElement).click();
    const req = http.expectOne(`${B}/sessions/sess1/bill-config`);
    expect(req.request.body.addedIds).toEqual(['z']);
    req.flush(response());
  });

  it('an overridden row shows its walk-in chip off and disabled even if the roster marks it', async () => {
    const body = response();
    // d is a walk-in on the roster, but its amount is overridden: the engine
    // reports row.walkIn false and charges no fee.
    body.config.overrides = [{ playerId: 'd', amountSatang: 5000 }];
    body.result.rows[1] = { ...body.result.rows[1], walkIn: false, walkInFeeSatang: 0, walkInDiscountSatang: 0,
      overridden: true, amountSatang: 5000 };
    await load(body);
    const chip = fixture.nativeElement.querySelector('[data-walk-in="d"]') as HTMLButtonElement;
    expect(chip.classList.contains('selected')).toBe(false);
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    expect(chip.disabled).toBe(true);
    expect(chip.getAttribute('title')).toBeTruthy();
    const other = fixture.nativeElement.querySelector('[data-walk-in="a"]') as HTMLButtonElement;
    expect(other.disabled).toBe(false);
    expect(other.getAttribute('title')).toBeNull();
  });

  it('removing a player who played puts them in removedIds', async () => {
    await load();
    fixture.componentInstance['remove']('a');
    const req = http.expectOne(`${B}/sessions/sess1/bill-config`);
    expect(req.request.body.removedIds).toEqual(['a']);
    req.flush(response());
  });

  it('removing an added no-show who has no games just un-adds them', async () => {
    const body = response();
    body.config.addedIds = ['z'];
    body.result.rows.push({ playerId: 'z', games: 0, status: 'billed', added: true, walkIn: false, courtSatang: 0,
      shuttleSatang: 0, baseSatang: 0, hostFeeSatang: 0, walkInFeeSatang: 0, walkInDiscountSatang: 0, overridden: false,
      amountSatang: 0 });
    await load(body);
    fixture.componentInstance['remove']('z');
    const req = http.expectOne(`${B}/sessions/sess1/bill-config`);
    expect(req.request.body.addedIds).toEqual([]);
    expect(req.request.body.removedIds).toEqual([]);
    req.flush(response());
  });

  it('removing a player added as a no-show who then played also puts them in removedIds', async () => {
    const body = response();
    // a was added before playing and has since played a game: a real row with
    // games > 0, still listed in addedIds. Un-adding alone would bill them anyway.
    body.config.addedIds = ['a'];
    await load(body);
    fixture.componentInstance['remove']('a');
    const req = http.expectOne(`${B}/sessions/sess1/bill-config`);
    expect(req.request.body.addedIds).toEqual([]);
    expect(req.request.body.removedIds).toEqual(['a']);
    req.flush(response());
  });

  it('rejects a malformed money entry without posting', async () => {
    await load();
    fixture.componentInstance['onMoney']('hostFeeSatang', '12.345');
    fixture.detectChanges();
    http.expectNone(`${B}/sessions/sess1/bill-config`);
    expect(fixture.nativeElement.querySelector('[role="alert"]')).not.toBeNull();
  });

  describe('shuttle accounting and the copy guard', () => {
    const el = () => fixture.nativeElement as HTMLElement;
    const copyButton = () => el().querySelector('.bill-footer button.primary') as HTMLButtonElement;
    const withAccounting = (over: Partial<BillResponse['accounting']>, extra: Partial<BillResponse> = {}): BillResponse => {
      const base = response();
      return {
        ...base,
        session: { ...base.session, shuttleToolsEnabled: true },
        accounting: { ...base.accounting, source: 'physical', allocation: 'identities', ...over },
        ...extra,
      };
    };
    const incomplete = (): BillResponse => {
      const base = response();
      return { ...base, readyToCopy: false, result: { ...base.result, warnings: ['MISSING_SHUTTLE_COUNT'] }, accounting: { ...base.accounting, source: 'missing', effectiveCount: null, physicalCount: null } };
    };

    it('hides the per-person amounts and the total, and disables copy, while a required input is missing', async () => {
      await load(incomplete());
      expect(el().textContent).toContain('ยังไม่ได้ใส่จำนวนลูก');
      expect(el().querySelectorAll('.amount').length).toBe(0);
      expect(el().querySelector('.total')).toBeNull();
      expect(copyButton().disabled).toBe(true);
      expect(el().textContent).toContain('ยังคัดลอกไม่ได้');
    });

    it('does not touch the clipboard or show fallback text when copy() is called anyway', async () => {
      await load(incomplete());
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      await (fixture.componentInstance as unknown as { copy(): Promise<void> }).copy();
      fixture.detectChanges();
      expect(writeText).not.toHaveBeenCalled();
      expect(el().querySelector('.clipboard-fallback')).toBeNull();
    });

    it('shows amounts and copies when the bill is ready, including perGame with no shuttle inputs', async () => {
      await load({ ...response(), config: { ...response().config, model: 'perGame' } });
      expect(el().querySelectorAll('.amount').length).toBeGreaterThan(0);
      expect(copyButton().disabled).toBe(false);
    });

    it('explains the billed shuttle count and where it came from', async () => {
      await load(withAccounting({ source: 'games', recordedFinishedShuttles: 3, physicalCount: null, effectiveCount: 3 }));
      expect(el().textContent).toContain('3');
      expect(el().textContent).toContain('นับจากแมตช์ที่บันทึกไว้');
    });

    it('says when a physical count is used, and shows the difference only when every game is recorded', async () => {
      await load(withAccounting({ source: 'physical', recordedFinishedShuttles: 3, unknownFinishedMatches: 0, finishedMatches: 3, physicalCount: 5, effectiveCount: 5 }));
      expect(el().textContent).toContain('นับจริง');
      expect(el().textContent).toContain('+2');
    });

    it('does not show a difference while some game has no recorded shuttles', async () => {
      await load(withAccounting({ source: 'physical', recordedFinishedShuttles: 3, unknownFinishedMatches: 1, finishedMatches: 3, physicalCount: 5, effectiveCount: 5, allocation: 'legacy-unknown' }));
      expect(el().textContent).not.toContain('+2');
    });

    it('announces the equal-per-match fallback instead of mixing guessed and known uses', async () => {
      await load(withAccounting({ source: 'physical', unknownFinishedMatches: 2, finishedMatches: 3, physicalCount: 5, effectiveCount: 5, allocation: 'legacy-unknown' }));
      expect(el().textContent).toContain('หารค่าลูกเท่ากันทุกแมตช์');
    });

    it('explains the no-recorded-uses fallback too', async () => {
      await load(withAccounting({ source: 'physical', finishedMatches: 2, physicalCount: 5, effectiveCount: 5, allocation: 'legacy-no-uses' }));
      expect(el().textContent).toContain('ไม่ได้บันทึกลูกแบด');
    });

    it('shows no shuttle accounting panel on an ordinary session', async () => {
      await load(response());
      expect(el().querySelector('.shuttle-accounting')).toBeNull();
    });
  });

  describe('early checkouts and the fourth model', () => {
    const advanced = (over: Partial<BillResponse> = {}): BillResponse => {
      const b = response();
      b.session.shuttleToolsEnabled = true;
      return { ...b, ...over };
    };
    const settledBill = (): BillResponse => {
      const b = advanced();
      b.settled = [{ id: 'r1', playerId: 'z', name: 'Zed', model: 'perGame', amountSatang: 5000, settledAt: '2026-10-01T10:00:00Z' }];
      b.result.totals = { ...b.result.totals, settledTotalSatang: 5000, stillDueSatang: 20000, collectedSatang: 25000 };
      return b;
    };
    const el = () => fixture.nativeElement as HTMLElement;

    it('an advanced session offers the fourth model; an ordinary one keeps three', async () => {
      await load(advanced());
      expect(el().querySelector('[data-model="perShuttle"]')).toBeTruthy();
      expect(el().querySelectorAll('[data-model]')).toHaveLength(4);
    });

    it('an ordinary bill never offers perShuttle, whatever the group switch is now', async () => {
      await load();
      expect(el().querySelector('[data-model="perShuttle"]')).toBeNull();
      expect(el().querySelectorAll('[data-model]')).toHaveLength(3);
    });

    it('perShuttle shows the starting fee input and points to the summary for the shuttle price', async () => {
      const b = advanced();
      b.config.model = 'perShuttle';
      await load(b);
      expect(el().querySelector('[data-starting-fee]')).toBeTruthy();
      const link = el().querySelector('[data-per-shuttle-hint] a') as HTMLAnchorElement;
      expect(link.getAttribute('href')).toContain('/s/sess1/summary');
    });

    it('saving a starting fee posts it in the full config', async () => {
      const b = advanced();
      b.config.model = 'perShuttle';
      await load(b);
      const input = el().querySelector('[data-starting-fee]') as HTMLInputElement;
      input.value = '30';
      input.dispatchEvent(new Event('change'));
      const req = http.expectOne(`${B}/sessions/sess1/bill-config`);
      expect(req.request.body).toMatchObject({ model: 'perShuttle', startingFeeSatang: 3000 });
      req.flush(b);
      await new Promise((r) => setTimeout(r, 0));
    });

    it('a settled leaver appears once, read-only, and is not a still-due row, removable row or addable chip', async () => {
      await load(settledBill());
      const rows = el().querySelector('[data-settled-rows]')!;
      expect(rows.textContent).toContain('Zed');
      expect(rows.textContent).toContain('50');
      expect(rows.querySelector('button, input')).toBeNull();
      expect(el().querySelector('[data-add="z"]')).toBeNull();
      expect(el().textContent).toContain('ยังต้องจ่าย');
    });

    it('shows settled and still-due totals next to the whole', async () => {
      await load(settledBill());
      const split = el().querySelector('[data-split-totals]')!.textContent!;
      expect(split).toContain('50');
      expect(split).toContain('200');
      expect(el().textContent).toContain('250');
    });

    it('an excess or shortfall warning blocks copying and shows the amount to resolve', async () => {
      const b = settledBill();
      b.readyToCopy = false;
      b.result.warnings = ['EXCESS_CREDIT'];
      b.result.totals = { ...b.result.totals, excessCreditSatang: 2000 };
      await load(b);
      expect(el().textContent).toContain('20฿');
      expect(el().textContent).toContain('คืนเงินเอง');
      const copy = el().querySelector('button.primary') as HTMLButtonElement;
      expect(copy.disabled).toBe(true);
      const clip = vi.fn();
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: clip }, configurable: true });
      await (fixture.componentInstance as unknown as { copy(): Promise<void> }).copy();
      expect(clip).not.toHaveBeenCalled();
      expect(el().querySelector('textarea.clipboard-fallback')).toBeNull();
    });

    it('uncovered cost and unreturned surcharge are explained too', async () => {
      const b = settledBill();
      b.readyToCopy = false;
      b.result.warnings = ['UNCOVERED_COST', 'UNRETURNED_SURCHARGE'];
      b.result.totals = { ...b.result.totals, uncoveredCostSatang: 4000, unreturnedSurchargeSatang: 2000 };
      await load(b);
      expect(el().textContent).toContain('ไม่มีใครเหลือจ่าย');
      expect(el().textContent).toContain('40฿');
      expect(el().textContent).toContain('ไม่นับเป็นกำไร');
    });

    it('a bill with no checkouts shows no settled section or split', async () => {
      await load(advanced());
      expect(el().querySelector('[data-settled-rows]')).toBeNull();
      expect(el().querySelector('[data-split-totals]')).toBeNull();
    });
  });
});
