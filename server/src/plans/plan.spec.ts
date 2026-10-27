import { effectivePlan, planAtLeast, GROUP_LIMIT, rankForCap, lapsedAt, upgradeContactUrl } from './plan.js';

const now = new Date('2026-10-20T12:00:00+07:00');
const host = (plan: string, planRenewsAt: Date | null) => ({
  role: 'host',
  plan,
  planRenewsAt,
});

describe('plan rules', () => {
  it('treats an ownerless group as club', () =>
    expect(effectivePlan(null, now)).toBe('club'));
  it('treats an admin owner as club whatever the column says', () =>
    expect(
      effectivePlan({ role: 'admin', plan: 'free', planRenewsAt: null }, now),
    ).toBe('club'));
  it('keeps a paid plan with no renewal date', () =>
    expect(effectivePlan(host('host', null), now)).toBe('host'));
  it('keeps a paid plan until the instant after renewal', () =>
    expect(effectivePlan(host('club', now), now)).toBe('club'));
  it('drops a lapsed plan to free', () =>
    expect(
      effectivePlan(host('host', new Date(now.getTime() - 1)), now),
    ).toBe('free'));
  it('reads an unknown plan string as free', () =>
    expect(effectivePlan(host('gold', null), now)).toBe('free'));
  it('orders plans', () => {
    expect(planAtLeast('club', 'host')).toBe(true);
    expect(planAtLeast('host', 'host')).toBe(true);
    expect(planAtLeast('free', 'host')).toBe(false);
    expect(planAtLeast('host', 'club')).toBe(false);
  });
  it('pins the group limits', () =>
    expect(GROUP_LIMIT).toEqual({ free: 1, host: 3, club: 10 }));
});

describe('rankForCap', () => {
  const g = (code: string, createdAt: string, lastSessionAt: string | null) => ({
    code,
    createdAt: new Date(createdAt),
    lastSessionAt: lastSessionAt ? new Date(lastSessionAt) : null,
  });
  it('puts the group with the newest session first', () =>
    expect(
      rankForCap([g('a', '2026-01-01', '2026-10-01'), g('b', '2026-02-01', '2026-10-05')]),
    ).toEqual(['b', 'a']));
  it('ranks a group with no session below any group with one', () =>
    expect(
      rankForCap([g('new', '2026-10-20', null), g('old', '2026-01-01', '2026-02-01')]),
    ).toEqual(['old', 'new']));
  it('ranks a group with a night in progress above one with a newer session', () =>
    expect(
      rankForCap([g('newer', '2026-02-01', '2026-10-05'), { ...g('running', '2026-01-01', '2026-10-01'), live: true }]),
    ).toEqual(['running', 'newer']));
  it('breaks a tie by newer createdAt, then by code', () => {
    expect(rankForCap([g('a', '2026-01-01', null), g('b', '2026-02-01', null)])).toEqual(['b', 'a']);
    expect(rankForCap([g('b', '2026-01-01', null), g('a', '2026-01-01', null)])).toEqual(['a', 'b']);
  });
});

describe('lapsedAt', () => {
  const past = new Date('2026-10-10T16:59:59.999Z');
  const owner = (plan: string, planRenewsAt: Date | null, role = 'host') => ({ role, plan, planRenewsAt });
  it('returns the renewal date of a paid plan that has lapsed', () =>
    expect(lapsedAt(owner('host', past), now)).toEqual(past));
  it('is null for a free plan, an admin, no renewal date and a plan still in date', () => {
    expect(lapsedAt(owner('free', past), now)).toBeNull();
    expect(lapsedAt(owner('host', past, 'admin'), now)).toBeNull();
    expect(lapsedAt(owner('host', null), now)).toBeNull();
    expect(lapsedAt(owner('host', new Date('2026-11-01T00:00:00Z')), now)).toBeNull();
    expect(lapsedAt(null, now)).toBeNull();
  });
});

describe('upgradeContactUrl', () => {
  it('keeps an https url', () =>
    expect(upgradeContactUrl('https://line.me/R/ti/p/@jubbad')).toBe('https://line.me/R/ti/p/@jubbad'));
  it.each([undefined, '', 'http://x.test', 'javascript:alert(1)', 'line.me/x'])('rejects %s', (raw) =>
    expect(upgradeContactUrl(raw)).toBeNull());
});
