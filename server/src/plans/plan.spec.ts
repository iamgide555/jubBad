import { effectivePlan, planAtLeast, GROUP_LIMIT } from './plan.js';

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
