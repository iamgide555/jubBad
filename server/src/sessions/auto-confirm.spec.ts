import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTO_CONFIRM_SWEEP_MS, AutoConfirmScheduler } from './auto-confirm.js';
import type { SessionsService } from './sessions.service.js';

describe('AutoConfirmScheduler', () => {
  let calls: number;
  let concurrent: number;
  let maxConcurrent: number;
  let resolveFns: Array<() => void>;
  let fakeService: { autoConfirmDue: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    calls = 0;
    concurrent = 0;
    maxConcurrent = 0;
    resolveFns = [];
    fakeService = {
      autoConfirmDue: vi.fn(() => {
        calls++;
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        return new Promise<string[]>((resolve) => {
          resolveFns.push(() => {
            concurrent--;
            resolve([]);
          });
        });
      }),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks every AUTO_CONFIRM_SWEEP_MS and never overlaps a slow tick', async () => {
    const scheduler = new AutoConfirmScheduler(fakeService as unknown as SessionsService);
    scheduler.onApplicationBootstrap();

    await vi.advanceTimersByTimeAsync(AUTO_CONFIRM_SWEEP_MS);
    expect(calls).toBe(1);

    // The first call is still pending — a second tick must be skipped, not queued.
    await vi.advanceTimersByTimeAsync(AUTO_CONFIRM_SWEEP_MS);
    expect(calls).toBe(1);

    resolveFns[0]();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(AUTO_CONFIRM_SWEEP_MS);
    expect(calls).toBe(2);
    expect(maxConcurrent).toBe(1);

    scheduler.onModuleDestroy();
  });

  it('stops ticking after onModuleDestroy', async () => {
    const scheduler = new AutoConfirmScheduler(fakeService as unknown as SessionsService);
    scheduler.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(AUTO_CONFIRM_SWEEP_MS);
    resolveFns[0]();
    await vi.advanceTimersByTimeAsync(0);

    scheduler.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(AUTO_CONFIRM_SWEEP_MS * 3);
    expect(calls).toBe(1);
  });

  it('logs and keeps ticking when a sweep rejects', async () => {
    fakeService.autoConfirmDue.mockRejectedValueOnce(new Error('boom')).mockResolvedValue([]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const scheduler = new AutoConfirmScheduler(fakeService as unknown as SessionsService);
    scheduler.onApplicationBootstrap();

    await vi.advanceTimersByTimeAsync(AUTO_CONFIRM_SWEEP_MS);
    expect(errorSpy).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(AUTO_CONFIRM_SWEEP_MS);
    expect(fakeService.autoConfirmDue).toHaveBeenCalledTimes(2);

    scheduler.onModuleDestroy();
    errorSpy.mockRestore();
  });
});
