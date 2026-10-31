import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { PaymentCalculation } from './payment-calculation';
import type { BillModel, BillResponse } from '../../core/bill.model';
function bill(model: BillModel = 'fair', advanced = false): BillResponse {
  return {
    session: {
      code: 'one',
      date: null,
      venue: null,
      endedAt: null,
      shuttleCount: 99,
      shuttlePriceSatang: 8500,
      shuttleToolsEnabled: advanced,
    },
    config: {
      model,
      courtFeeSatang: 120000,
      courtSplit: 'equal',
      shuttleSplit: 'byGames',
      perGameRateSatang: 2500,
      entryFeeSatang: 5000,
      capSatang: null,
      buffetPriceSatang: 20000,
      buffetShuttlesIncluded: true,
      startingFeeSatang: 10000,
      shuttleCharge: 'shared',
      perPlayerShuttleSatang: null,
      hostFeeSatang: 0,
      walkInFeeSatang: 0,
      roundingBaht: 1,
      addedIds: [],
      removedIds: [],
      absentIds: [],
      overrides: [],
    },
    configSource: 'previous',
    players: [],
    settled: [],
    result: {
      rows: [],
      warnings: [],
      totals: {
        collectedSatang: 0,
        settledTotalSatang: 0,
        stillDueSatang: 0,
        excessCreditSatang: 0,
        uncoveredCostSatang: 0,
        unreturnedSurchargeSatang: 0,
        costSatang: null,
        marginSatang: null,
        billedCount: 0,
        walkInCount: 0,
      },
    },
    accounting: {
      recordedFinishedShuttles: 12,
      unknownFinishedMatches: 0,
      finishedMatches: 4,
      physicalCount: 99,
      effectiveCount: 12,
      source: 'games',
      allocation: 'identities',
    },
    readyToCopy: true,
  };
}
describe('PaymentCalculation', () => {
  let fixture: ComponentFixture<PaymentCalculation>;
  let http: HttpTestingController;
  const url = '/api/sessions/one';
  const el = () => fixture.nativeElement as HTMLElement;
  const select = () => el().querySelector('select')!;
  async function settle() {
    await Promise.resolve();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }
  function mount() {
    fixture = TestBed.createComponent(PaymentCalculation);
    fixture.componentRef.setInput('sessionCode', 'one');
    fixture.detectChanges();
  }
  async function open(data = bill()) {
    mount();
    http.expectOne(`${url}/bill`).flush(data);
    await settle();
  }
  function change(model: string) {
    select().value = model;
    select().dispatchEvent(new Event('change'));
  }
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PaymentCalculation],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());
  it('shows inherited fees and effective count without fee inputs or advanced choice', async () => {
    await open();
    expect(el().textContent).toContain('ใช้ค่าจากรอบก่อน');
    expect(el().textContent).toContain('12 × 85฿');
    expect(el().textContent).toContain('1,200฿');
    expect(el().querySelectorAll('input').length).toBe(0);
    expect([...select().options].map((o) => o.value)).toEqual(['fair', 'perGame', 'buffet']);
  });
  it('posts only model, emitting changing before request and changed before unlock', async () => {
    await open();
    const events: string[] = [];
    fixture.componentInstance.changing.subscribe((v) => events.push(`changing:${v}`));
    fixture.componentInstance.changed.subscribe((b) => events.push(b.config.model));
    change('perGame');
    expect(events).toEqual(['changing:true']);
    const request = http.expectOne(`${url}/bill-method`);
    expect(request.request.body).toEqual({ model: 'perGame' });
    request.flush(bill('perGame'));
    await settle();
    expect(events).toEqual(['changing:true', 'perGame', 'changing:false']);
    expect(select().value).toBe('perGame');
    expect(el().textContent).toContain('ไม่จำกัด');
  });
  it('preserves fees and resyncs the parent even when recovery reports the old method', async () => {
    await open();
    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    change('buffet');
    http.expectOne(`${url}/bill-method`).flush({}, { status: 500, statusText: 'Error' });
    await Promise.resolve();
    http.expectOne(`${url}/bill`).flush(bill());
    await settle();
    expect(select().value).toBe('fair');
    expect(el().textContent).toContain('1,200฿');
    expect(el().querySelector('[role="alert"]')).not.toBeNull();
    expect(changed).toHaveBeenCalledOnce();
    expect(changed.mock.calls[0][0].config.model).toBe('fair');
  });
  it('holds changing through a lost response recovery and emits the committed method', async () => {
    await open();
    const events: string[] = [];
    fixture.componentInstance.changing.subscribe((v) => events.push(`changing:${v}`));
    fixture.componentInstance.changed.subscribe((b) => events.push(b.config.model));
    change('buffet');
    http.expectOne(`${url}/bill-method`).flush({}, { status: 0, statusText: 'Unknown Error' });
    await Promise.resolve();
    expect(events).toEqual(['changing:true']);
    const recovery = http.expectOne(`${url}/bill`);
    recovery.flush(bill('buffet'));
    await settle();
    expect(events).toEqual(['changing:true', 'buffet', 'changing:false']);
    expect(select().value).toBe('buffet');
    expect(el().querySelector('[role="alert"]')!.textContent).toContain(
      'เปลี่ยนวิธีคิดเงินไม่สำเร็จ',
    );
  });
  it('reports uncertainty if recovery fails and emits changed after a later successful retry', async () => {
    await open();
    const events: string[] = [];
    fixture.componentInstance.changing.subscribe((v) => events.push(`changing:${v}`));
    fixture.componentInstance.changed.subscribe((b) => events.push(b.config.model));
    fixture.componentInstance.uncertain.subscribe(() => events.push('uncertain'));
    change('buffet');
    http.expectOne(`${url}/bill-method`).flush({}, { status: 0, statusText: 'Unknown Error' });
    await Promise.resolve();
    http.expectOne(`${url}/bill`).flush({}, { status: 503, statusText: 'Unavailable' });
    await settle();
    expect(events).toEqual(['changing:true', 'uncertain', 'changing:false']);
    expect(select().value).toBe('fair');
    expect(select().getAttribute('aria-disabled')).toBe('true');
    el().querySelector<HTMLButtonElement>('[data-retry]')!.click();
    http.expectOne(`${url}/bill`).flush(bill('buffet'));
    await settle();
    expect(events).toEqual(['changing:true', 'uncertain', 'changing:false', 'buffet']);
    expect(select().value).toBe('buffet');
  });
  it('keeps locked selection focusable and guards changes', async () => {
    await open();
    fixture.componentRef.setInput('locked', true);
    await settle();
    expect(select().disabled).toBe(false);
    expect(select().getAttribute('aria-disabled')).toBe('true');
    change('perGame');
    http.expectNone(`${url}/bill-method`);
    expect(select().value).toBe('fair');
  });
  it('rejects duplicate changes during save', async () => {
    await open();
    change('perGame');
    change('buffet');
    http.expectOne(`${url}/bill-method`).flush(bill('perGame'));
    await settle();
  });
  it('offers retry after unavailable details', async () => {
    mount();
    http.expectOne(`${url}/bill`).flush({}, { status: 503, statusText: 'Unavailable' });
    await settle();
    el().querySelector<HTMLButtonElement>('[data-retry]')!.click();
    http.expectOne(`${url}/bill`).flush(bill());
    await settle();
    expect(select().value).toBe('fair');
  });
  it('ignores previous-session reads', async () => {
    mount();
    const old = http.expectOne(`${url}/bill`);
    fixture.componentRef.setInput('sessionCode', 'two');
    fixture.detectChanges();
    http.expectOne('/api/sessions/two/bill').flush(bill('buffet'));
    await settle();
    old.flush(bill());
    await settle();
    expect(select().value).toBe('buffet');
  });
  it('does not emit a previous-session save', async () => {
    await open();
    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    change('perGame');
    const old = http.expectOne(`${url}/bill-method`);
    fixture.componentRef.setInput('sessionCode', 'two');
    fixture.detectChanges();
    http.expectOne('/api/sessions/two/bill').flush(bill('buffet'));
    await settle();
    old.flush(bill('perGame'));
    await settle();
    expect(changed).not.toHaveBeenCalled();
    expect(select().value).toBe('buffet');
  });
  it('refreshes when refreshKey changes', async () => {
    await open();
    fixture.componentRef.setInput('refreshKey', 1);
    fixture.detectChanges();
    http.expectOne(`${url}/bill`).flush(bill('buffet'));
    await settle();
    expect(select().value).toBe('buffet');
  });
  it('distinguishes real cost from full player charge', async () => {
    const data = bill('perShuttle', true);
    data.config.shuttleCharge = 'full';
    data.config.perPlayerShuttleSatang = 3000;
    await open(data);
    expect([...select().options].map((o) => o.value)).toContain('perShuttle');
    expect(el().querySelector('[data-real-shuttle-cost]')!.textContent).toContain('85฿');
    expect(el().querySelector('[data-player-shuttle-charge]')!.textContent).toContain('30฿');
  });
  it('shows buffet inclusion and hides irrelevant fees', async () => {
    await open(bill('buffet'));
    expect(el().textContent).toContain('200฿');
    expect(el().textContent).toContain('รวมค่าลูกแล้ว');
    expect(el().textContent).not.toContain('1,200฿');
  });
});
