import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { environment } from '../../environments/environment';
import { UpgradeSheetService } from './upgrade-sheet.service';

const B = environment.apiBaseUrl;
const mine = (upgradeUrl: string | null) => ({
  plan: 'free',
  renewsAt: null,
  lapsedAt: null,
  groupCount: 1,
  groupLimit: 1,
  upgradeUrl,
});

describe('UpgradeSheetService', () => {
  let service: UpgradeSheetService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(UpgradeSheetService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('starts closed and makes no request until it is opened', () => {
    expect(service.isOpen()).toBe(false);
    expect(service.contactUrl()).toBeNull();
  });

  it('opens at once and fills the contact link from /plans/me, loading it only once', async () => {
    service.open();
    expect(service.isOpen()).toBe(true);
    httpMock.expectOne(`${B}/plans/me`).flush(mine('https://line.me/R/ti/p/@jubbad'));
    await Promise.resolve();
    await Promise.resolve();
    expect(service.contactUrl()).toBe('https://line.me/R/ti/p/@jubbad');
    service.close();
    service.open();
    httpMock.expectNone(`${B}/plans/me`);
    expect(service.isOpen()).toBe(true);
  });

  it('still opens, text only, when the load fails, and retries on the next open', async () => {
    service.open();
    httpMock.expectOne(`${B}/plans/me`).flush('x', { status: 500, statusText: 'err' });
    await Promise.resolve();
    await Promise.resolve();
    expect(service.isOpen()).toBe(true);
    expect(service.contactUrl()).toBeNull();
    service.close();
    service.open();
    httpMock.expectOne(`${B}/plans/me`).flush(mine(null));
  });

  it('closes', () => {
    service.open();
    httpMock.expectOne(`${B}/plans/me`).flush(mine(null));
    service.close();
    expect(service.isOpen()).toBe(false);
  });
});
