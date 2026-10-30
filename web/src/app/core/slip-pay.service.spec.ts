import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { environment } from '../../environments/environment';
import { SlipPayService } from './slip-pay.service';

describe('SlipPayService', () => {
  let service: SlipPayService;
  let http: HttpTestingController;
  const base = `${environment.apiBaseUrl}/sessions/${encodeURIComponent('s/1 x')}/slip-pay`;
  const tok = encodeURIComponent('t&k=1');

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(SlipPayService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('config: GETs /config with the token and no LINE header', () => {
    let got: unknown;
    service.config('s/1 x', 't&k=1').subscribe((v) => (got = v));
    const req = http.expectOne(`${base}/config?token=${tok}`);
    expect(req.request.method).toBe('GET');
    expect(req.request.headers.has('X-Line-Access-Token')).toBe(false);
    req.flush({ liffId: 'L-1' });
    expect(got).toEqual({ liffId: 'L-1' });
  });

  it('view: GETs with the token and the access token header', () => {
    const body = { amountSatang: 17200, playerName: 'มายด์', claimable: [], accountName: 'A', alreadyPaid: false };
    let got: unknown;
    service.view('s/1 x', 't&k=1', 'ACCESS').subscribe((v) => (got = v));
    const req = http.expectOne(`${base}?token=${tok}`);
    expect(req.request.method).toBe('GET');
    expect(req.request.headers.get('X-Line-Access-Token')).toBe('ACCESS');
    req.flush(body);
    expect(got).toEqual(body);
  });

  it('claim: POSTs the player id as JSON with the header', () => {
    let got: unknown;
    service.claim('s/1 x', 't&k=1', 'ACCESS', 'p1').subscribe((v) => (got = v));
    const req = http.expectOne(`${base}/claim?token=${tok}`);
    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('X-Line-Access-Token')).toBe('ACCESS');
    expect(req.request.body).toEqual({ playerId: 'p1' });
    req.flush({ outcome: 'linked' });
    expect(got).toEqual({ outcome: 'linked' });
  });

  it('upload: POSTs the raw file with its own content type and the header', () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'slip.png', { type: 'image/png' });
    let got: unknown;
    service.upload('s/1 x', 't&k=1', 'ACCESS', file).subscribe((v) => (got = v));
    const req = http.expectOne(`${base}/upload?token=${tok}`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toBe(file);
    expect(req.request.headers.get('X-Line-Access-Token')).toBe('ACCESS');
    // Not forced to JSON: either unset (the browser uses the File's type) or the file's own type.
    const ct = req.request.headers.get('Content-Type');
    expect(ct === null || ct === 'image/png').toBe(true);
    expect(req.request.detectContentTypeHeader()).toBe('image/png');
    req.flush({ outcome: 'paid' });
    expect(got).toEqual({ outcome: 'paid' });
  });
});
