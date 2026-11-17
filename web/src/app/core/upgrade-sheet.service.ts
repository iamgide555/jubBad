import { Injectable, Injector, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { PlanService } from './plan.service';

/**
 * The one "what does Host give me" sheet every plan lock opens. Root-scoped so a
 * lock anywhere can open it without owning the dialog. The contact link comes
 * from the server (`GET /plans/me`), read on first open; without it, or on a
 * failed read, the sheet shows text only. PlanService is resolved lazily so a
 * page that merely renders a lock never makes a request.
 */
@Injectable({ providedIn: 'root' })
export class UpgradeSheetService {
  private readonly injector = inject(Injector);
  private loaded = false;

  readonly isOpen = signal(false);
  readonly contactUrl = signal<string | null>(null);
  /** The LIFF page that links LINE, only while the trial is still on offer to this account. */
  readonly trialLinkUrl = signal<string | null>(null);

  open(): void {
    this.isOpen.set(true);
    void this.load();
  }

  close(): void {
    this.isOpen.set(false);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const mine = await firstValueFrom(this.injector.get(PlanService).mine());
      this.contactUrl.set(mine.upgradeUrl);
      this.trialLinkUrl.set(mine.trialAvailable && mine.linkUrl ? mine.linkUrl : null);
    } catch {
      // Text only; the next open tries again.
      this.loaded = false;
    }
  }
}
