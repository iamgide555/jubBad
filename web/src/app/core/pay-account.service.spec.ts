import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { PayAccountService } from './pay-account.service';

const URL = `${environment.apiBaseUrl}/groups/group1/pay-account`;
const ACCOUNT = { bank: 'กสิกร', number: '123-4-56789-0', name: 'สมชาย ใจดี' };

describe('PayAccountService', () => {
  let service: PayAccountService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(PayAccountService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('reads the saved account out of the response envelope', async () => {
    const result = firstValueFrom(service.get('group1'));
    httpMock.expectOne({ url: URL, method: 'GET' }).flush({ account: ACCOUNT });
    expect(await result).toEqual(ACCOUNT);
  });

  it('reads no account as null', async () => {
    const result = firstValueFrom(service.get('group1'));
    httpMock.expectOne(URL).flush({ account: null });
    expect(await result).toBeNull();
  });

  it('saves with PUT and returns the stored account', async () => {
    const result = firstValueFrom(service.set('group1', ACCOUNT));
    const req = httpMock.expectOne({ url: URL, method: 'PUT' });
    expect(req.request.body).toEqual(ACCOUNT);
    req.flush({ account: ACCOUNT });
    expect(await result).toEqual(ACCOUNT);
  });

  it('clearing sends all-blank fields and reads back null', async () => {
    const result = firstValueFrom(service.set('group1', null));
    const req = httpMock.expectOne({ url: URL, method: 'PUT' });
    expect(req.request.body).toEqual({ bank: '', number: '', name: '' });
    req.flush({ account: null });
    expect(await result).toBeNull();
  });

  it('reads the account together with the collector', async () => {
    const result = firstValueFrom(service.getWithCollector('group1'));
    httpMock.expectOne({ url: URL, method: 'GET' }).flush({ account: ACCOUNT, collectorPlayerId: 'p1', collectorStale: false });
    expect(await result).toEqual({ account: ACCOUNT, collectorPlayerId: 'p1', collectorStale: false });
  });

  it('reads a lapsed pick as stale', async () => {
    const result = firstValueFrom(service.getWithCollector('group1'));
    httpMock.expectOne(URL).flush({ account: ACCOUNT, collectorPlayerId: null, collectorStale: true });
    expect(await result).toEqual({ account: ACCOUNT, collectorPlayerId: null, collectorStale: true });
  });

  it('reads a missing collector as null', async () => {
    const result = firstValueFrom(service.getWithCollector('group1'));
    httpMock.expectOne(URL).flush({ account: null });
    expect(await result).toEqual({ account: null, collectorPlayerId: null, collectorStale: false });
  });

  it('sets the collector with PUT and returns the stored id', async () => {
    const result = firstValueFrom(service.setCollector('group1', 'p1'));
    const req = httpMock.expectOne({ url: `${environment.apiBaseUrl}/groups/group1/pay-collector`, method: 'PUT' });
    expect(req.request.body).toEqual({ playerId: 'p1' });
    req.flush({ collectorPlayerId: 'p1' });
    expect(await result).toBe('p1');
  });

  it('clears the collector by sending null', async () => {
    const result = firstValueFrom(service.setCollector('group1', null));
    const req = httpMock.expectOne({ url: `${environment.apiBaseUrl}/groups/group1/pay-collector`, method: 'PUT' });
    expect(req.request.body).toEqual({ playerId: null });
    req.flush({ collectorPlayerId: null });
    expect(await result).toBeNull();
  });
});
