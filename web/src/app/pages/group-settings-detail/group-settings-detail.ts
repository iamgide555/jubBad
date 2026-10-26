import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { isPaid, onButInactiveLockHint, planErrorMessage, type Plan } from '../../core/plan';
import { PlanService } from '../../core/plan.service';
import { RosterService } from '../../core/roster.service';
import { findOwnDuplicate, sameGroupName, type OwnGroupRow } from '../../core/group-name';
import { isDetailSection, settingsReturn, type DetailSection } from '../../core/settings-sections';
import { PlanLock } from '../../shared/plan-lock/plan-lock';
import { ShareDashboardPanel } from '../../shared/share-dashboard-panel/share-dashboard-panel';

/**
 * One group setting at a time: sharing, advanced switches, or managing the
 * group itself (rename, export, delete). Moved off the old group-entry page so
 * every setting is reachable before a session exists. The back link names the
 * group and returns to its settings row, so a host with several groups never
 * loses which one they are editing.
 */
@Component({
  selector: 'app-group-settings-detail',
  imports: [FormsModule, RouterLink, ShareDashboardPanel, PlanLock],
  templateUrl: './group-settings-detail.html',
  styleUrl: './group-settings-detail.css',
})
export class GroupSettingsDetail {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly roster = inject(RosterService);
  private readonly planService = inject(PlanService);

  protected readonly groupCode = this.route.snapshot.paramMap.get('groupCode')!;
  private readonly rawSection = this.route.snapshot.paramMap.get('section');
  protected readonly section: DetailSection | null = isDetailSection(this.rawSection) ? this.rawSection : null;

  readonly status = signal<'loading' | 'ready' | 'not-found' | 'error'>('loading');
  readonly groupName = signal('');
  protected readonly back = computed(() => settingsReturn(this.groupCode, this.section ?? 'manage'));

  // advanced
  readonly shuttleTools = signal<boolean | null>(null);
  readonly crossSessionHistory = signal<boolean | null>(null);
  readonly advancedLoadFailed = signal(false);
  readonly advancedSaving = signal(false);
  readonly advancedError = signal<string | null>(null);
  readonly advancedSaved = signal(false);

  // manage
  readonly renameDraft = signal('');
  readonly renaming = signal(false);
  readonly renameError = signal<string | null>(null);
  readonly renameSaved = signal(false);
  /** Same-name courtesy note on rename; a second save with this name goes ahead. */
  readonly renameDuplicateOf = signal<{ code: string; name: string } | null>(null);
  private readonly ownGroups = signal<OwnGroupRow[]>([]);
  readonly deleteConfirmText = signal('');
  readonly dangerError = signal<string | null>(null);
  readonly canDelete = computed(
    () => this.groupName().trim().length > 0 && this.deleteConfirmText().trim() === this.groupName().trim()
  );

  /**
   * The group owner's plan. A failed or still-pending read is `null`, which `isPaid` treats as
   * paid: a hiccup must never lock a host out (the server still refuses what the plan does not
   * allow).
   */
  private readonly plan = signal<Plan | null>(null);
  protected readonly paid = computed(() => isPaid(this.plan()));

  constructor() {
    void this.load();
    void this.loadPlan();
  }

  private async loadPlan(): Promise<void> {
    try {
      this.plan.set((await firstValueFrom(this.planService.forGroup(this.groupCode))).plan);
    } catch {
      // Unknown plan: leave everything enabled; the server still refuses what the plan does not allow.
    }
  }

  /**
   * On the free plan a switch cannot be turned ON. One that is already on stays enabled, so a
   * lapsed host can always turn it off (the plan hint still shows beside it, whatever its value).
   */
  protected switchLocked(which: 'shuttleTools' | 'crossSessionHistory'): boolean {
    const value = which === 'shuttleTools' ? this.shuttleTools() : this.crossSessionHistory();
    return !this.paid() && value === false;
  }

  /**
   * A switch that is ON on the free plan stays ON (so it can be turned off), but sessions
   * snapshot it off at creation. It is drawn muted, with its own line saying so.
   */
  protected switchInactive(which: 'shuttleTools' | 'crossSessionHistory'): boolean {
    const value = which === 'shuttleTools' ? this.shuttleTools() : this.crossSessionHistory();
    return !this.paid() && value === true;
  }

  protected readonly onButInactiveHint = onButInactiveLockHint();

  async load(): Promise<void> {
    this.status.set('loading');
    try {
      const group = await firstValueFrom(this.roster.getGroup(this.groupCode));
      this.groupName.set(group.name ?? '');
      this.renameDraft.set(group.name ?? '');
      this.status.set('ready');
      if (this.section === 'advanced') this.loadAdvanced();
      if (this.section === 'manage') {
        this.roster.listGroups().subscribe({ next: (g) => this.ownGroups.set(g), error: () => undefined });
      }
    } catch (err) {
      this.status.set(err instanceof HttpErrorResponse && err.status === 404 ? 'not-found' : 'error');
    }
  }

  private loadAdvanced(): void {
    this.roster.getShuttleTools(this.groupCode).subscribe({
      next: (r) => this.shuttleTools.set(r.enabled),
      error: () => this.advancedLoadFailed.set(true),
    });
    this.roster.getCrossSessionHistory(this.groupCode).subscribe({
      next: (r) => this.crossSessionHistory.set(r.enabled),
      error: () => this.advancedLoadFailed.set(true),
    });
  }

  /**
   * Saves one switch. The box never shows an unsaved value: it snaps back to
   * the saved state at once (while disabled for the write) and only moves when
   * the server confirms, so a failed save cannot leave it lying.
   */
  setAdvanced(which: 'shuttleTools' | 'crossSessionHistory', input: HTMLInputElement): void {
    const target = which === 'shuttleTools' ? this.shuttleTools : this.crossSessionHistory;
    const enabled = input.checked;
    input.checked = target() === true;
    this.advancedError.set(null);
    this.advancedSaved.set(false);
    this.advancedSaving.set(true);
    const save =
      which === 'shuttleTools'
        ? this.roster.setShuttleTools(this.groupCode, enabled)
        : this.roster.setCrossSessionHistory(this.groupCode, enabled);
    save.subscribe({
      next: (r) => {
        target.set(r.enabled);
        input.checked = r.enabled;
        this.advancedSaving.set(false);
        this.advancedSaved.set(true);
      },
      error: (err) => {
        this.advancedError.set(planErrorMessage(err) ?? $localize`:@@entry.advancedSaveFailed:บันทึกไม่สำเร็จ ลองอีกครั้ง`);
        this.advancedSaving.set(false);
      },
    });
  }

  async rename(): Promise<void> {
    if (this.renaming()) return;
    const name = this.renameDraft().trim();
    this.renameSaved.set(false);
    if (!name) {
      this.renameError.set($localize`:@@entry.errNoGroupName:กรุณาใส่ชื่อก๊วนก่อน`);
      return;
    }
    const warned = this.renameDuplicateOf();
    if (!(warned && sameGroupName(warned.name, name))) {
      const clash = findOwnDuplicate(this.ownGroups(), name, this.groupCode);
      if (clash) {
        this.renameDuplicateOf.set(clash);
        return;
      }
    }
    this.renameDuplicateOf.set(null);
    this.renameError.set(null);
    this.renaming.set(true);
    try {
      const saved = await firstValueFrom(this.roster.renameGroup(this.groupCode, name));
      this.groupName.set(saved.name ?? name);
      this.renameDraft.set(saved.name ?? name);
      this.renameSaved.set(true);
    } catch {
      this.renameError.set($localize`:@@entry.renameFailed:บันทึกชื่อก๊วนไม่สำเร็จ`);
    } finally {
      this.renaming.set(false);
    }
  }

  async exportGroup(): Promise<void> {
    this.dangerError.set(null);
    try {
      const data = await firstValueFrom(this.roster.exportGroup(this.groupCode));
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `jubbad-${this.groupCode}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      this.dangerError.set(planErrorMessage(err) ?? $localize`:@@entry.exportFailed:ดาวน์โหลดไม่สำเร็จ`);
    }
  }

  async deleteGroup(): Promise<void> {
    if (!this.canDelete()) return;
    this.dangerError.set(null);
    try {
      await firstValueFrom(this.roster.deleteGroup(this.groupCode));
      await this.router.navigateByUrl('/');
    } catch {
      this.dangerError.set($localize`:@@entry.deleteFailed:ลบก๊วนไม่สำเร็จ`);
    }
  }
}
