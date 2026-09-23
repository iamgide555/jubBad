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
    session: { code: 'sess1', date: null, venue: null, endedAt: null, shuttleCount: 0, shuttlePriceSatang: 0 },
    config: {
      model: 'fair', courtFeeSatang: 20000, courtSplit: 'equal', shuttleSplit: 'byGames', perGameRateSatang: 0,
      entryFeeSatang: 0, capSatang: null, buffetPriceSatang: 0, buffetShuttlesIncluded: true, hostFeeSatang: 0,
      walkInFeeSatang: 2000, roundingBaht: 1, addedIds: [], removedIds: [], overrides: [],
    },
    configSource: 'saved',
    players: [
      { playerId: 'a', name: 'Amp', games: 1, walkIn: false },
      { playerId: 'd', name: 'Dee', games: 1, walkIn: true },
      { playerId: 'z', name: 'Zed', games: 0, walkIn: false },
    ],
    result: {
      rows: [
        { playerId: 'a', games: 1, status: 'billed', added: false, walkIn: false, courtSatang: 10000, shuttleSatang: 0,
          baseSatang: 10000, hostFeeSatang: 0, walkInFeeSatang: 0, walkInDiscountSatang: 1000, overridden: false, amountSatang: 9000 },
        { playerId: 'd', games: 1, status: 'billed', added: false, walkIn: true, courtSatang: 10000, shuttleSatang: 0,
          baseSatang: 10000, hostFeeSatang: 0, walkInFeeSatang: 2000, walkInDiscountSatang: 1000, overridden: false, amountSatang: 11000 },
      ],
      totals: { collectedSatang: 20000, costSatang: 20000, marginSatang: 0, billedCount: 2, walkInCount: 1 },
      warnings: [],
    },
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

  it('rejects a malformed money entry without posting', async () => {
    await load();
    fixture.componentInstance['onMoney']('hostFeeSatang', '12.345');
    fixture.detectChanges();
    http.expectNone(`${B}/sessions/sess1/bill-config`);
    expect(fixture.nativeElement.querySelector('[role="alert"]')).not.toBeNull();
  });
});
