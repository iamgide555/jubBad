import { HttpErrorResponse } from '@angular/common/http';
import { NgTemplateOutlet } from '@angular/common';
import { Component, DestroyRef, OnInit, computed, inject, input, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { LineService } from '../../core/line.service';
import type { LineHostStatus, LineLinkCode } from '../../core/line.model';
import { copyToClipboard } from '../../core/share-link';
import { PlanLock } from '../../shared/plan-lock/plan-lock';

/** How often the panel asks whether the host's LINE has linked, while a code is waiting. */
export const LINE_HOST_POLL_MS = 5000;

/**
 * The host's own LINE chat with the bot as a way to hand this group its roster: a roster sent
 * there by direct message reaches start. The account link is per user (one code, `/link <code>`
 * sent to the bot, polling until it lands) and linking from this page also switches this group
 * on; after that each group has its own switch, and the bot only offers the groups that are on.
 */
@Component({
  selector: 'app-line-host-link-panel',
  imports: [NgTemplateOutlet, PlanLock],
  templateUrl: './line-host-link-panel.html',
  styleUrl: './line-host-link-panel.css',
})
export class LineHostLinkPanel implements OnInit {
  /**
   * The page's plan read (the group owner's, which is the signed-in host on their own group).
   * Only making a code is paid; unlink always stays open. A 403 on making a code locks it
   * regardless, since the server judges the host's own plan.
   */
  readonly paid = input(true);
  readonly groupCode = input.required<string>();

  private readonly lineService = inject(LineService);

  protected readonly status = signal<LineHostStatus | null>(null);
  protected readonly loadFailed = signal(false);
  /** The code waiting to be sent to the bot, until it links, expires or is replaced. */
  protected readonly pending = signal<LineLinkCode | null>(null);
  private readonly now = signal(Date.now());
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly confirmingUnlink = signal(false);
  protected readonly copied = signal<'yes' | 'failed' | null>(null);
  /** A 403 on making a code: the host's own plan does not include it. */
  private readonly refused = signal(false);
  /** A 503 on making a code: the server lost its LINE channel since the status was read. */
  private readonly unconfigured = signal(false);
  protected readonly notConfigured = computed(() => this.unconfigured() || this.status()?.configured === false);
  protected readonly locked = computed(() => this.refused() || !this.paid());
  /** The header tag: on, on but paused by the plan, or off. Null until the status is read. */
  protected readonly chip = computed<'on' | 'paused' | 'off' | null>(() => {
    const s = this.status();
    if (!s || this.notConfigured()) return null;
    if (!s.accountLinked || !s.enabled) return 'off';
    return this.paid() ? 'on' : 'paused';
  });
  protected readonly minutesLeft = computed(() => {
    const p = this.pending();
    return p ? Math.max(1, Math.ceil((new Date(p.expiresAt).getTime() - this.now()) / 60000)) : 0;
  });
  private poll: ReturnType<typeof setInterval> | undefined;

  protected readonly lockHint = $localize`:@@line.host.lock:การรับรายชื่อทางแชตส่วนตัวใช้ได้ในแพ็ก⁠เกจโฮสต์`;
  protected readonly pausedHint = $localize`:@@line.host.paused:แพ็ก⁠เกจหมดอายุ บอทหยุดรับรายชื่อจากแชตส่วนตัวชั่วคราว ต่ออายุแล้วจะกลับมาทำงานเอง`;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stopPoll());
  }

  ngOnInit(): void {
    this.load();
  }

  protected chipText(): string {
    switch (this.chip()) {
      case 'on':
        return $localize`:@@line.host.stateOn:เปิดอยู่`;
      case 'paused':
        return $localize`:@@line.host.statePaused:หยุดชั่วคราว`;
      default:
        return $localize`:@@line.host.stateOff:ยังไม่เปิด`;
    }
  }

  protected load(): void {
    this.loadFailed.set(false);
    this.lineService.hostStatus(this.groupCode()).subscribe({
      next: (s) => this.status.set(s),
      error: () => this.loadFailed.set(true),
    });
  }

  protected expiresInText(): string {
    const minutes = this.minutesLeft();
    return $localize`:@@line.expiresIn:หมดอายุใน ${minutes}:minutes: นาที`;
  }

  protected async createCode(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.copied.set(null);
    try {
      const made = await firstValueFrom(this.lineService.hostCreateCode(this.groupCode()));
      this.now.set(Date.now());
      this.pending.set(made);
      this.startPoll();
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 503) this.unconfigured.set(true);
      else if (err instanceof HttpErrorResponse && err.status === 403) this.refused.set(true);
      else if (err instanceof HttpErrorResponse && err.status === 409) this.load();
      else this.error.set($localize`:@@line.codeFailed:สร้างรหัสไม่สำเร็จ ลองอีกครั้ง`);
    } finally {
      this.busy.set(false);
    }
  }

  protected async copyCommand(): Promise<void> {
    const pending = this.pending();
    if (!pending) return;
    this.copied.set((await copyToClipboard(`/link ${pending.code}`)) ? 'yes' : 'failed');
  }

  /** Asks every few seconds whether the host's LINE linked; gives up when the code runs out. */
  private startPoll(): void {
    this.stopPoll();
    this.poll = setInterval(() => void this.pollStatus(), LINE_HOST_POLL_MS);
  }

  private stopPoll(): void {
    if (this.poll !== undefined) clearInterval(this.poll);
    this.poll = undefined;
  }

  private async pollStatus(): Promise<void> {
    const pending = this.pending();
    this.now.set(Date.now());
    if (!pending || Date.now() >= new Date(pending.expiresAt).getTime()) {
      this.pending.set(null);
      this.stopPoll();
      return;
    }
    try {
      const status = await firstValueFrom(this.lineService.hostStatus(this.groupCode()));
      if (status.accountLinked) {
        this.status.set(status);
        this.pending.set(null);
        this.stopPoll();
      }
    } catch {
      // A missed poll is harmless: the next tick asks again.
    }
  }

  /** Saves this group's switch. The box only moves when the server confirms. */
  protected async setEnabled(input: HTMLInputElement): Promise<void> {
    const was = this.status();
    if (!was || this.busy()) return;
    const on = input.checked;
    input.checked = was.enabled;
    this.busy.set(true);
    this.error.set(null);
    try {
      const saved = await firstValueFrom(this.lineService.hostSetEnabled(this.groupCode(), on));
      this.status.set({ ...was, enabled: saved.enabled });
      input.checked = saved.enabled;
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 403) this.refused.set(true);
      else if (err instanceof HttpErrorResponse && err.status === 409) this.load();
      else this.error.set($localize`:@@line.host.enableFailed:บันทึกไม่สำเร็จ ลองอีกครั้ง`);
    } finally {
      this.busy.set(false);
    }
  }

  protected async unlink(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(this.lineService.hostUnlink(this.groupCode()));
      this.confirmingUnlink.set(false);
      const was = this.status();
      if (was) this.status.set({ ...was, accountLinked: false, enabled: false });
    } catch {
      this.error.set($localize`:@@line.host.unlinkFailed:ยกเลิกการผูกบัญชีไม่สำเร็จ ลองอีกครั้ง`);
    } finally {
      this.busy.set(false);
    }
  }
}
