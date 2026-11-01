import { vi } from 'vitest';
import type { LineAccountsService } from './line-accounts.service.js';
import type { LineHostService } from './line-host.service.js';
import type { LineLinkService } from './line-link.service.js';
import type { LineRosterService } from './line-roster.service.js';
import { LinePurgeScheduler } from './line-purge.js';

describe('LinePurgeScheduler.tick', () => {
  afterEach(() => vi.restoreAllMocks());

  function build(sweep: () => Promise<unknown>) {
    const roster = { purge: vi.fn().mockResolvedValue(undefined) };
    const link = { purgeExpiredCodes: vi.fn().mockResolvedValue(undefined) };
    const host = { purgeExpired: vi.fn().mockResolvedValue(undefined) };
    const accounts = { sweep: vi.fn(sweep) };
    const scheduler = new LinePurgeScheduler(
      roster as unknown as LineRosterService,
      link as unknown as LineLinkService,
      host as unknown as LineHostService,
      accounts as unknown as LineAccountsService
    );
    const tick = () => (scheduler as unknown as { tick(): Promise<void> }).tick();
    return { roster, link, host, accounts, tick };
  }

  it('runs every purge when all succeed', async () => {
    const { roster, link, host, accounts, tick } = build(async () => ({ memberships: 0, accounts: 0 }));
    await tick();
    expect(roster.purge).toHaveBeenCalledTimes(1);
    expect(accounts.sweep).toHaveBeenCalledTimes(1);
    expect(link.purgeExpiredCodes).toHaveBeenCalledTimes(1);
    expect(host.purgeExpired).toHaveBeenCalledTimes(1);
  });

  it('a throwing account sweep does not skip the code and pending-roster purges', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { link, host, tick } = build(async () => {
      throw new Error('sweep boom');
    });
    await tick();
    expect(link.purgeExpiredCodes).toHaveBeenCalledTimes(1);
    expect(host.purgeExpired).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('[line-purge] account sweep failed', expect.any(Error));
  });
});
