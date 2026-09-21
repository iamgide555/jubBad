import { Injectable, Module, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { SessionsModule } from './sessions.module.js';
import { SessionsService } from './sessions.service.js';

/** How often the sweep looks for a pending match past its auto-confirm
 *  delay. Independent of `AUTO_CONFIRM_DELAY_MS` (sessions.service.ts) —
 *  this is how often to check, not how long to wait. */
export const AUTO_CONFIRM_SWEEP_MS = 5_000;

/**
 * Runs `SessionsService.autoConfirmDue` on a timer for the life of the
 * process — see docs/superpowers/specs/2026-09-22-auto-confirm-pending-
 * match-design.md §3. A plain `setInterval` rather than `@nestjs/schedule`:
 * one repeating timer does not need a scheduling library.
 *
 * Kept out of `SessionsModule` on purpose: the session specs build their
 * test app from `SessionsModule` alone and share one test database per run,
 * and a background sweep inside those apps would race their own
 * pending-pairing fixtures, confirming a row a test is still mid-assertion
 * on. Only `AppModule` imports `AutoConfirmModule`, so only a full-app boot
 * (production, or the two specs that build one — see
 * `auth.boundary.spec.ts`, `admin.spec.ts`) gets the timer; those two never
 * leave a pending pairing sitting 60s old, so it's inert for them.
 */
@Injectable()
export class AutoConfirmScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(private readonly sessions: SessionsService) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), AUTO_CONFIRM_SWEEP_MS);
    // Never holds the process — or a test run's event loop — open on its own.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Skips a tick already in flight rather than overlapping it — a slow
   *  sweep shrinks toward one-at-a-time, never stacks. */
  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.sessions.autoConfirmDue();
    } catch (error) {
      console.error('[auto-confirm] sweep failed', error);
    } finally {
      this.running = false;
    }
  }
}

@Module({
  imports: [SessionsModule],
  providers: [AutoConfirmScheduler],
})
export class AutoConfirmModule {}
