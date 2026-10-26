import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { environment } from '../../environments/environment';
import { LineService } from './line.service';

const B = environment.apiBaseUrl;

describe('LineService', () => {
  let service: LineService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(LineService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('reads the status of a group', () => {
    const status = {
      configured: true,
      botAddUrl: 'https://lin.ee/x',
      linked: false,
      lineGroupName: null,
      linkedAt: null,
      leftAt: null,
      summaryDefault: true,
    };
    let got: unknown;
    service.status('g 1').subscribe((s) => (got = s));
    const req = httpMock.expectOne(`${B}/groups/g%201/line`);
    expect(req.request.method).toBe('GET');
    req.flush(status);
    expect(got).toEqual(status);
  });

  it('creates a link code with a POST', () => {
    let got: unknown;
    service.createCode('g1').subscribe((c) => (got = c));
    const req = httpMock.expectOne(`${B}/groups/g1/line/code`);
    expect(req.request.method).toBe('POST');
    req.flush({ code: 'K7P2QX', expiresAt: '2026-10-26T10:10:00.000Z' });
    expect(got).toEqual({ code: 'K7P2QX', expiresAt: '2026-10-26T10:10:00.000Z' });
  });

  it('unlinks with a DELETE', () => {
    let got: unknown;
    service.unlink('g1').subscribe((r) => (got = r));
    const req = httpMock.expectOne(`${B}/groups/g1/line`);
    expect(req.request.method).toBe('DELETE');
    req.flush({ unlinked: true });
    expect(got).toEqual({ unlinked: true });
  });

  it('reads the latest roster', () => {
    let got: unknown;
    service.latestRoster('g1').subscribe((r) => (got = r));
    const req = httpMock.expectOne(`${B}/groups/g1/line/latest-roster`);
    expect(req.request.method).toBe('GET');
    req.flush({ roster: null });
    expect(got).toEqual({ roster: null });
  });

  it('reads the summary card state of a session', () => {
    let got: unknown;
    service.summaryState('S 1').subscribe((s) => (got = s));
    const req = httpMock.expectOne(`${B}/sessions/S%201/line-summary`);
    expect(req.request.method).toBe('GET');
    req.flush({ available: true, sent: false, defaultOn: true });
    expect(got).toEqual({ available: true, sent: false, defaultOn: true });
  });

  it('sends the summary card with a POST', () => {
    let got: unknown;
    service.sendSummary('S1').subscribe((r) => (got = r));
    const req = httpMock.expectOne(`${B}/sessions/S1/line-summary`);
    expect(req.request.method).toBe('POST');
    req.flush({ outcome: 'sent' });
    expect(got).toEqual({ outcome: 'sent' });
  });

  it('saves the summary default with a PATCH', () => {
    let got: unknown;
    service.setSummaryDefault('g1', false).subscribe((r) => (got = r));
    const req = httpMock.expectOne(`${B}/groups/g1/line`);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ summaryDefault: false });
    req.flush({ summaryDefault: false });
    expect(got).toEqual({ summaryDefault: false });
  });
});
