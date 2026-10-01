import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, type Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { absoluteUrl, copyToClipboard } from '../../core/share-link';

interface ShareState {
  token: string | null;
}

/**
 * Host-only controls for the group's public dashboard link. Loads when it is
 * rendered (the group page only renders it once the host opens it), so the
 * page makes no extra request until asked.
 *
 * Stopping the share breaks the link already pinned in LINE, so it takes a
 * second, explicit tap.
 */
@Component({
  selector: 'app-share-dashboard-panel',
  templateUrl: './share-dashboard-panel.html',
  styleUrl: './share-dashboard-panel.css',
})
export class ShareDashboardPanel implements OnInit {
  readonly groupCode = input.required<string>();

  private readonly http = inject(HttpClient);

  /** undefined = still loading; null = not shared. */
  protected readonly token = signal<string | null | undefined>(undefined);
  protected readonly unavailable = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly copied = signal(false);
  protected readonly copyFailed = signal(false);
  protected readonly confirmingStop = signal(false);

  protected readonly link = computed(() => {
    const t = this.token();
    return t ? absoluteUrl(`/d/${t}`) : null;
  });

  private endpoint(): string {
    return `${environment.apiBaseUrl}/groups/${encodeURIComponent(this.groupCode())}/share`;
  }

  async ngOnInit(): Promise<void> {
    try {
      const state = await firstValueFrom(this.http.get<ShareState>(this.endpoint()));
      this.token.set(state.token);
    } catch {
      // A group that has not been created yet has nothing to share.
      this.unavailable.set(true);
    }
  }

  protected async share(): Promise<void> {
    await this.change(() => this.http.post<ShareState>(this.endpoint(), {}), $localize`:@@share.shareFailed:สร้างลิงก์ไม่สำเร็จ ลองอีกครั้ง`);
  }

  protected async stop(): Promise<void> {
    await this.change(() => this.http.delete<ShareState>(this.endpoint()), $localize`:@@share.stopFailed:หยุดแชร์ไม่สำเร็จ ลองอีกครั้ง`);
  }

  protected async copy(): Promise<void> {
    const link = this.link();
    if (!link) return;
    const ok = await copyToClipboard(link);
    this.copied.set(ok);
    this.copyFailed.set(!ok);
  }

  private async change(call: () => Observable<ShareState>, failure: string): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.copied.set(false);
    this.copyFailed.set(false);
    try {
      const state = await firstValueFrom(call());
      this.token.set(state.token);
      this.confirmingStop.set(false);
    } catch {
      this.error.set(failure);
    } finally {
      this.busy.set(false);
    }
  }
}
