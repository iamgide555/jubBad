import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { CollectorSlipService } from './collector-slip.service';

const BASE = `${environment.apiBaseUrl}/sessions/abc/slip-pay/manage`;
const MANAGE = {
  groupName: 'ก๊วน',
  date: '30 ต.ค. 2569',
  accountName: 'สมชาย',
  rows: [{ playerId: 'p1', name: 'A', amountSatang: 10000, absent: false }],
  paid: [{ playerId: 'p1', source: 'collector', at: '2026-10-30T10:00:00Z', amountChangedSince: false }],
  waiting: [],
  duplicates: [],
  links: [],
  collection: { closedAt: null, canClose: false, imageCount: 0 },
};

describe('CollectorSlipService', () => {
  let service: CollectorSlipService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [CollectorSlipService, provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(CollectorSlipService);
    http = TestBed.inject(HttpTestingController);
    service.configure('T O/K', 'ACCESS');
  });

  afterEach(() => http.verify());

  it('sends the card token in the query and the LINE access token in the header on a read', async () => {
    const result = firstValueFrom(service.manage('abc'));
    const req = http.expectOne(`${BASE}?token=T%20O%2FK`);
    expect(req.request.method).toBe('GET');
    expect(req.request.headers.get('X-Line-Access-Token')).toBe('ACCESS');
    req.flush(MANAGE);
    expect((await result).rows).toEqual(MANAGE.rows);
  });

  it('maps the manage response to a panel with no linked accounts', async () => {
    const result = firstValueFrom(service.panel('abc'));
    http.expectOne(`${BASE}?token=T%20O%2FK`).flush({ ...MANAGE, links: [{ playerId: 'x', displayName: 'n', linkedBy: 'host' }] });
    const panel = await result;
    expect(panel.links).toEqual([]);
    expect(panel.paid).toEqual(MANAGE.paid);
    expect(panel.collection).toEqual(MANAGE.collection);
    expect(panel.waiting).toEqual([]);
    expect(panel.duplicates).toEqual([]);
  });

  it('fetches an image with the header and returns a blob: URL', async () => {
    const result = firstValueFrom(service.image('abc', 'i/1'));
    const req = http.expectOne(`${BASE}/images/i%2F1?token=T%20O%2FK`);
    expect(req.request.headers.get('X-Line-Access-Token')).toBe('ACCESS');
    expect(req.request.responseType).toBe('blob');
    req.flush(new Blob(['x'], { type: 'image/png' }));
    expect(await result).toMatch(/^blob:/);
  });

  it('posts tick and untick with the player id', () => {
    service.tick('abc', 'p1').subscribe();
    const tick = http.expectOne(`${BASE}/tick?token=T%20O%2FK`);
    expect(tick.request.body).toEqual({ playerId: 'p1' });
    expect(tick.request.headers.get('X-Line-Access-Token')).toBe('ACCESS');
    tick.flush({ ok: true });
    service.untick('abc', 'p1').subscribe();
    const untick = http.expectOne(`${BASE}/untick?token=T%20O%2FK`);
    expect(untick.request.body).toEqual({ playerId: 'p1' });
    untick.flush({ ok: true });
  });

  it('posts resolve and the two dismisses to the waiting and duplicates routes', () => {
    const body = { coversPlayerIds: ['p1'], reviewedAmountSatang: 10000, senderPlayerId: null };
    service.resolve('abc', 'w1', body).subscribe();
    const resolve = http.expectOne(`${BASE}/waiting/w1/resolve?token=T%20O%2FK`);
    expect(resolve.request.body).toEqual(body);
    resolve.flush({ ok: true });
    service.dismiss('abc', 'w1').subscribe();
    const dismiss = http.expectOne(`${BASE}/waiting/w1/dismiss?token=T%20O%2FK`);
    expect(dismiss.request.body).toEqual({});
    dismiss.flush({ ok: true });
    service.dismissDuplicate('abc', 'd1').subscribe();
    const dup = http.expectOne(`${BASE}/duplicates/d1/dismiss?token=T%20O%2FK`);
    expect(dup.request.body).toEqual({});
    dup.flush({ ok: true });
  });

  it('closes the collection confirming the image deletion', () => {
    service.closeCollection('abc').subscribe();
    const req = http.expectOne(`${BASE}/close?token=T%20O%2FK`);
    expect(req.request.body).toEqual({ confirmDeleteImages: true });
    expect(req.request.headers.get('X-Line-Access-Token')).toBe('ACCESS');
    req.flush({ ok: true });
  });

  it('refuses the host-only actions without a request', async () => {
    await expect(firstValueFrom(service.updateName('abc', 'w1'))).rejects.toBeDefined();
    await expect(firstValueFrom(service.setLink('abc', 'p1', null))).rejects.toBeDefined();
  });
});
