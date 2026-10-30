import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { environment } from '../../environments/environment';
import { SlipHostService } from './slip-host.service';

const BASE = `${environment.apiBaseUrl}/sessions/sess%201/payments`;

describe('SlipHostService', () => {
  let svc: SlipHostService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    svc = TestBed.inject(SlipHostService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('provides encoded private image URLs and explicitly confirms image deletion on close', () => {
    expect((svc as any).imageUrl('sess 1', 'img/1')).toBe(`${BASE}/images/img%2F1`);
    (svc as any).closeCollection('sess 1').subscribe();
    const req = http.expectOne(`${BASE}/close`);
    expect(req.request.body).toEqual({ confirmDeleteImages: true });
    req.flush({ ok: true });
  });

  it('reads the whole panel with one GET', () => {
    const body = { paid: [], waiting: [], duplicates: [], links: [] };
    let got: unknown;
    svc.panel('sess 1').subscribe((r) => (got = r));
    const req = http.expectOne(BASE);
    expect(req.request.method).toBe('GET');
    req.flush(body);
    expect(got).toEqual(body);
  });

  it('ticks and unticks by player id', () => {
    svc.tick('sess 1', 'p1').subscribe();
    const tick = http.expectOne(`${BASE}/tick`);
    expect(tick.request.method).toBe('POST');
    expect(tick.request.body).toEqual({ playerId: 'p1' });
    tick.flush({ ok: true });

    svc.untick('sess 1', 'p1').subscribe();
    const untick = http.expectOne(`${BASE}/untick`);
    expect(untick.request.body).toEqual({ playerId: 'p1' });
    untick.flush({ ok: true });
  });

  it('resolves a waiting slip with both lists', () => {
    svc.resolve('sess 1', 'w/1', { coversPlayerIds: ['a', 'b'], senderPlayerId: 'a' }).subscribe();
    const req = http.expectOne(`${BASE}/waiting/w%2F1/resolve`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ coversPlayerIds: ['a', 'b'], senderPlayerId: 'a' });
    req.flush({ ok: true });
  });

  it('dismisses a waiting slip and a duplicate, and updates the saved name', () => {
    svc.dismiss('sess 1', 'w1').subscribe();
    http.expectOne(`${BASE}/waiting/w1/dismiss`).flush({ ok: true });
    svc.updateName('sess 1', 'w1').subscribe();
    http.expectOne(`${BASE}/waiting/w1/update-name`).flush({ ok: true });
    svc.dismissDuplicate('sess 1', 'd1').subscribe();
    http.expectOne(`${BASE}/duplicates/d1/dismiss`).flush({ ok: true });
  });

  it('removes a link by sending a null account', () => {
    svc.setLink('sess 1', 'p1', null).subscribe();
    const req = http.expectOne(`${BASE}/links`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ playerId: 'p1', lineUserId: null });
    req.flush({ ok: true });
  });
});
