import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectorRef, Component, DestroyRef, ElementRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { Group } from '../../core/group.model';
import type { GroupSession } from '../../core/group-session.model';
import { RosterService } from '../../core/roster.service';
import { isSettingsSection, type SettingsSection } from '../../core/settings-sections';
import { PressDirective } from '../../core/motion/press.directive';
import { Icon } from '../../shared/icon/icon';

interface RowValues {
  players?: number;
  levels?: { mode: 'standard' | 'custom'; count: number };
  shared?: boolean;
  advanced?: { shuttleTools: boolean; crossSessionHistory: boolean };
}

/**
 * A saved group's home. Settings live beside the group's name — one labelled
 * disclosure, closed by default, above the session actions, and it stays
 * there however much history the group grows (spec: Group home and settings).
 * Opening it may push the session actions down; that is the approved order.
 * The resume link sits in the header instead, so it never leaves the screen.
 *
 * A missing group is "not found", never a blank group to fill in: creating
 * happens only at /groups/new.
 */
@Component({
  selector: 'app-group-home',
  imports: [RouterLink, PressDirective, Icon],
  templateUrl: './group-home.html',
  styleUrl: './group-home.css',
  host: { '(document:keydown.escape)': 'closeOnEscape()' },
})
export class GroupHome {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly roster = inject(RosterService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly groupCode = this.route.snapshot.paramMap.get('groupCode')!;
  readonly status = signal<'loading' | 'ready' | 'not-found' | 'error'>('loading');
  readonly group = signal<Group | null>(null);
  readonly sessions = signal<GroupSession[]>([]);
  readonly settingsOpen = signal(false);
  readonly values = signal<RowValues>({});
  private valuesRequested = false;
  private destroyed = false;

  readonly latest = computed(() => {
    const code = this.group()?.lastSessionCode;
    if (!code) return null;
    return { code, date: this.sessions().find((s) => s.code === code)?.date ?? null };
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.destroyed = true));
    void this.load();
  }

  async load(): Promise<void> {
    this.status.set('loading');
    try {
      const [group, sessions] = await Promise.all([
        firstValueFrom(this.roster.getGroup(this.groupCode)),
        firstValueFrom(this.roster.listSessions(this.groupCode)),
      ]);
      if (this.destroyed) return;
      this.group.set(group);
      this.sessions.set(sessions);
      this.status.set('ready');
      this.restoreFromQuery();
    } catch (err) {
      this.status.set(err instanceof HttpErrorResponse && err.status === 404 ? 'not-found' : 'error');
    }
  }

  toggleSettings(): void {
    this.setSettings(!this.settingsOpen());
  }

  closeOnEscape(): void {
    if (!this.settingsOpen()) return;
    this.setSettings(false);
    this.host.nativeElement.querySelector<HTMLElement>('[data-settings-trigger]')?.focus();
  }

  rowLink(section: SettingsSection): string[] {
    return section === 'players' || section === 'levels'
      ? ['/g', this.groupCode, section]
      : ['/g', this.groupCode, 'settings', section];
  }

  playersValue(): string | null {
    const n = this.values().players;
    return n === undefined ? null : $localize`:@@group.value.players:${n}:count: คน`;
  }

  levelsValue(): string | null {
    const l = this.values().levels;
    if (!l) return null;
    return l.mode === 'standard'
      ? $localize`:@@group.value.levelsStandard:มาตรฐาน`
      : $localize`:@@group.value.levelsCustom:กำหนดเอง · ${l.count}:count: ระดับ`;
  }

  shareValue(): string | null {
    const s = this.values().shared;
    if (s === undefined) return null;
    return s ? $localize`:@@group.value.shared:แชร์อยู่` : $localize`:@@group.value.notShared:ยังไม่แชร์`;
  }

  advancedValue(): string | null {
    const a = this.values().advanced;
    if (!a) return null;
    const on = Number(a.shuttleTools) + Number(a.crossSessionHistory);
    if (on === 0) return $localize`:@@group.value.allOff:ปิดทั้งหมด`;
    if (on === 2) return $localize`:@@group.value.allOn:เปิดทั้งหมด`;
    return $localize`:@@group.value.oneOn:เปิด 1 จาก 2`;
  }

  /** On = something switched on: shown in the court-soft tint rather than neutral. */
  isOn(section: SettingsSection): boolean {
    const v = this.values();
    if (section === 'levels') return v.levels?.mode === 'custom';
    if (section === 'share') return v.shared === true;
    if (section === 'advanced') return !!v.advanced && (v.advanced.shuttleTools || v.advanced.crossSessionHistory);
    return false;
  }

  private setSettings(open: boolean): void {
    this.settingsOpen.set(open);
    if (open) this.loadValues();
  }

  /**
   * Back from a settings detail lands on /g/:code?settings=<section>: reopen,
   * focus that row, then drop the parameter with replaceUrl so a reload or
   * Back does not reopen settings.
   */
  private restoreFromQuery(): void {
    const section = this.route.snapshot.queryParamMap.get('settings');
    if (section === null) return;
    this.setSettings(true);
    if (isSettingsSection(section)) {
      // Render now so the list is un-hidden before focusing: focusing a
      // still-hidden element silently does nothing. A synchronous
      // detectChanges is deterministic; a timer or render hook only hoped
      // the render had happened.
      this.cdr.detectChanges();
      this.host.nativeElement.querySelector<HTMLElement>(`[data-section="${section}"]`)?.focus();
    }
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { settings: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /**
   * Live values, fetched once, on first open, from the owner-only endpoints —
   * never added to the public GET /groups/:code. A row whose fetch has not
   * answered, or failed, shows its static description only.
   */
  private loadValues(): void {
    if (this.valuesRequested) return;
    this.valuesRequested = true;
    const code = this.groupCode;
    const set = (patch: Partial<RowValues>) => this.values.update((v) => ({ ...v, ...patch }));
    const ignore = () => undefined;
    this.roster.getPlayers(code).subscribe({ next: (p) => set({ players: p.length }), error: ignore });
    this.roster
      .getGroupLevels(code)
      .subscribe({ next: (l) => set({ levels: { mode: l.mode, count: l.levels.length } }), error: ignore });
    this.roster.getShare(code).subscribe({ next: (s) => set({ shared: s.token !== null }), error: ignore });
    Promise.all([firstValueFrom(this.roster.getShuttleTools(code)), firstValueFrom(this.roster.getCrossSessionHistory(code))])
      .then(([shuttle, history]) =>
        set({ advanced: { shuttleTools: shuttle.enabled, crossSessionHistory: history.enabled } })
      )
      .catch(ignore);
  }
}
