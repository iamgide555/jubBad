import { Injectable, Module, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { LineAccountsService } from './line-accounts.service.js';
import { LineHostService } from './line-host.service.js';
import { LineLinkService } from './line-link.service.js';
import { LineRosterService } from './line-roster.service.js';
import { LineModule } from './line.module.js';

/** How often idle groups' old roster messages, spent link codes and stale LINE accounts are swept. */
export const LINE_PURGE_SWEEP_MS = 6 * 60 * 60 * 1000;

/**
 * Same shape as sessions/auto-confirm.ts: a plain unref'd setInterval, kept out
 * of LineModule so the specs that build it never get a background timer, and
 * imported only by AppModule. Capture already purges its own group each time;
 * this catches the groups nobody has posted in.
 */
@Injectable()
export class LinePurgeScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly roster: LineRosterService,
    private readonly link: LineLinkService,
    private readonly host: LineHostService,
    private readonly accounts: LineAccountsService
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), LINE_PURGE_SWEEP_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.roster.purge();
      // Its own guard: a failing account sweep must not skip the code and pending-roster purges below.
      try {
        await this.accounts.sweep();
      } catch (error) {
        console.error('[line-purge] account sweep failed', error);
      }
      await this.link.purgeExpiredCodes();
      await this.host.purgeExpired();
    } catch (error) {
      console.error('[line-purge] sweep failed', error);
    } finally {
      this.running = false;
    }
  }
}

@Module({
  imports: [LineModule],
  providers: [LinePurgeScheduler],
})
export class LinePurgeModule {}
