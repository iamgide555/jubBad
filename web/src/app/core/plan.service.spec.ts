import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { environment } from '../../environments/environment';
import { bangkokDate, bangkokDisplayDate, expiresSoon, isPaid, modesLockHint, planErrorMessage, type GroupPlan } from './plan';
import { PlanService } from './plan.service';

const B = environment.apiBaseUrl;

describe('PlanService', () => {
  let service: PlanService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(PlanService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it("loads the group owner's plan", () => {
    let got: unknown;
    service.forGroup('G1').subscribe((p) => (got = p));
    const req = httpMock.expectOne(`${B}/groups/G1/plan`);
    expect(req.request.method).toBe('GET');
    req.flush({ plan: 'host', renewsAt: null });
    expect(got).toEqual({ plan: 'host', renewsAt: null });
  });

  it("loads the signed-in user's own plan", () => {
    let got: unknown;
    service.mine().subscribe((p) => (got = p));
    const req = httpMock.expectOne(`${B}/plans/me`);
    expect(req.request.method).toBe('GET');
    const mine = { plan: 'free', renewsAt: null, lapsedAt: null, groupCount: 2, groupLimit: 1, upgradeUrl: null };
    req.flush(mine);
    expect(got).toEqual(mine);
  });
});

describe('expiresSoon', () => {
  const now = new Date('2026-10-26T12:00:00Z');
  const plan = (p: GroupPlan['plan'], renewsAt: string | null): GroupPlan => ({
    plan: p,
    renewsAt,
    lapsedAt: null,
    paused: false,
    archiveHidden: 0,
  });
  const inMs = (ms: number) => new Date(now.getTime() + ms).toISOString();
  const H = 3600 * 1000;

  it('is true with 4 days 23 hours left', () => expect(expiresSoon(plan('host', inMs(119 * H)), now)).toBe(true));
  it('is false with 5 days 1 hour left', () => expect(expiresSoon(plan('host', inMs(121 * H)), now)).toBe(false));
  it('is false once the date has passed', () => expect(expiresSoon(plan('host', inMs(-H)), now)).toBe(false));
  it('is false on free and with no renewal date', () => {
    expect(expiresSoon(plan('free', inMs(H)), now)).toBe(false);
    expect(expiresSoon(plan('host', null), now)).toBe(false);
  });
});

describe('plan copy', () => {
  it('keeps แพ็ก⁠เกจ unbreakable inside the lock hints', () => {
    expect(modesLockHint()).toContain('แพ็ก\u2060เกจ');
  });
});

describe('isPaid', () => {
  it('treats an unknown plan as paid so a failed load never locks the host out', () => {
    expect(isPaid(null)).toBe(true);
  });

  it('is false only for free', () => {
    expect(isPaid('free')).toBe(false);
    expect(isPaid('host')).toBe(true);
    expect(isPaid('club')).toBe(true);
  });
});

describe('planErrorMessage', () => {
  const refusal = (status: number, error: unknown) => new HttpErrorResponse({ status, error });

  it('names the limit on GROUP_LIMIT', () => {
    const msg = planErrorMessage(refusal(403, { code: 'GROUP_LIMIT', limit: 3 }));
    expect(msg).toBe('แพ็ก⁠เกจของคุณสร้างได้ 3 ก๊วน');
  });

  it('explains PLAN_REQUIRED', () => {
    const msg = planErrorMessage(refusal(403, { code: 'PLAN_REQUIRED', requiredPlan: 'host' }));
    expect(msg).toBe('ฟีเจอร์นี้ใช้ได้ในแพ็ก⁠เกจโฮสต์');
  });

  it('explains GROUP_PAUSED with the limit', () => {
    const msg = planErrorMessage(refusal(403, { code: 'GROUP_PAUSED', limit: 1 }));
    expect(msg).toBe('ก๊วนนี้พักไว้ — แพ็ก⁠เกจของคุณเปิดรอบได้ 1 ก๊วน (ก๊วนที่เล่นล่าสุด)');
  });

  it('ignores everything else', () => {
    expect(planErrorMessage(refusal(403, { code: 'FORBIDDEN' }))).toBeNull();
    expect(planErrorMessage(refusal(409, { code: 'PLAN_REQUIRED' }))).toBeNull();
    expect(planErrorMessage(new Error('x'))).toBeNull();
    expect(planErrorMessage(null)).toBeNull();
  });
});

describe('bangkokDate / bangkokDisplayDate', () => {
  it('reads a renewal instant (end of a Bangkok day) as that Bangkok calendar date', () => {
    expect(bangkokDate('2026-11-19T16:59:59.999Z')).toBe('2026-11-19');
    expect(bangkokDisplayDate('2026-11-19T16:59:59.999Z')).toBe('19/11/2026');
  });

  it('rolls past UTC midnight into the next Bangkok day', () => {
    expect(bangkokDisplayDate('2026-01-31T18:00:00.000Z')).toBe('01/02/2026');
  });

  it('is empty when there is no date', () => {
    expect(bangkokDate(null)).toBe('');
    expect(bangkokDisplayDate(null)).toBe('');
  });
});
