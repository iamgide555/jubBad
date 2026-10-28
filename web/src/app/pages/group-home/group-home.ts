import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectorRef, Component, DestroyRef, ElementRef, LOCALE_ID, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { Group } from '../../core/group.model';
import type { GroupSession } from '../../core/group-session.model';
import { isPaid, planLabel, planUntil, type GroupPlan } from '../../core/plan';
import { UpgradeSheetService } from '../../core/upgrade-sheet.service';
import { PlanNotice } from '../../shared/plan-notice/plan-notice';
import { PlanService } from '../../core/plan.service';
import { LineService } from '../../core/line.service';
import { RosterService } from '../../core/roster.service';
import { formatSessionDate, sessionState, type SessionState } from '../../core/session-date';
import { isSettingsSection, type SettingsSection } from '../../core/settings-sections';
import { PressDirective } from '../../core/motion/press.directive';
import { Icon } from '../../shared/icon/icon';

interface RowValues {
  players?: number;
  levels?: { mode: 'standard' | 'custom'; count: number };
  shared?: boolean;
  line?: { linked: boolean };
  advanced?: { shuttleTools: boolean; crossSessionHistory: boolean };
}

/**
 * A saved group's home. Settings live beside the group's name — one labelled
 * disclosure, closed by default, above the session actions, and it stays
 * there however much history the group grows (spec: Group home and settings).
 * Opening it may push the session actions down; that is the approved order.
 * The resume link sits in the header instead, so it never leaves the screen,
 * and it says what the latest session actually is: a green-ringed card while it
 * is tonight's, a plain card when it was left open, a text link once ended.
 *
 * A missing group is "not found", never a blank group to fill in: creating
 * happens only at /groups/new.
 */
@Component({
  selector: 'app-group-home',
  imports: [RouterLink, PressDirective, Icon, PlanNotice],
  templateUrl: './group-home.html',
  styleUrl: './group-home.css',
  host: { '(document:keydown.escape)': 'closeOnEscape()' },
})
export class GroupHome {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly roster = inject(RosterService);
  private readonly planService = inject(PlanService);
  private readonly lineService = inject(LineService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly locale = inject(LOCALE_ID);

  protected readonly groupCode = this.route.snapshot.paramMap.get('groupCode')!;
  readonly status = signal<'loading' | 'ready' | 'not-found' | 'error'>('loading');
  readonly group = signal<Group | null>(null);
  readonly sessions = signal<GroupSession[]>([]);
  readonly settingsOpen = signal(false);
  readonly values = signal<RowValues>({});
  private valuesRequested = false;
  private destroyed = false;

  /**
   * The group's latest session, joined to the already-loaded list. If it is not
   * in that list there is no data to describe it, so it is the plain ended-style
   * link with no state or date claim — never a live or open claim without data.
   */
  readonly latest = computed<{
    code: string;
    session: GroupSession | null;
    state: SessionState;
    dateLabel: string;
  } | null>(() => {
    const code = this.group()?.lastSessionCode;
    if (!code) return null;
    const session = this.sessions().find((s) => s.code === code) ?? null;
    if (!session) return { code, session: null, state: 'ended', dateLabel: '' };
    return { code, session, state: sessionState(session), dateLabel: formatSessionDate(session.date, this.locale) };
  });

  /** Past-session rows with the state and date label worked out once per load, not per change detection. */
  readonly pastRows = computed(() =>
    this.sessions().map((session) => ({
      session,
      state: sessionState(session),
      // A session saved without a date is still findable by its code.
      label: formatSessionDate(session.date, this.locale) || session.code,
    }))
  );

  /**
   * The group owner's plan, read to explain the archive window and to tell the host which plan
   * they are on. A failed or still-pending read is `null`, which `isPaid` treats as paid: no
   * note, no plan line, nothing hidden.
   */
  protected readonly plan = signal<GroupPlan | null>(null);
  protected readonly upgradeSheet = inject(UpgradeSheetService);
  /** A paused group keeps its data and any running session but cannot start a new one. */
  protected readonly paused = computed(() => this.plan()?.paused === true);
  /** The archive note shows only when the 30-day window actually hides something. */
  protected readonly archiveHidden = computed(() => this.plan()?.archiveHidden ?? 0);
  protected readonly paid = computed(() => isPaid(this.plan()?.plan ?? null));

  /**
   * "แพ็ก⁠เกจ: โฮสต์ · ถึง 19/11/2026" in the settings disclosure. The date shows only on a paid
   * effective plan: `renewsAt` is the raw stored date, so on free it may be a lapsed one.
   */
  protected readonly planLine = computed(() => {
    const p = this.plan();
    if (!p) return null;
    const name = planLabel(p.plan);
    const line = $localize`:@@group.planLine:แพ็ก⁠เกจ: ${name}:plan:`;
    return p.plan !== 'free' && p.renewsAt ? `${line} · ${planUntil(p.renewsAt)}` : line;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.destroyed = true));
    void this.load();
    void this.loadPlan();
  }

  private async loadPlan(): Promise<void> {
    try {
      const plan = await firstValueFrom(this.planService.forGroup(this.groupCode));
      if (!this.destroyed) this.plan.set(plan);
    } catch {
      // Unknown plan: no note; the list simply shows what the server returned.
    }
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
    // The upgrade sheet is modal: its own Escape closes it, and must not also fold the settings away.
    if (this.upgradeSheet.isOpen() || !this.settingsOpen()) return;
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

  /**
   * Linked reads "paused" on a plan that is not paid: the link and its Unlink stay, but the bot
   * has stopped keeping rosters (the server drops them), so "linked" alone would overpromise.
   */
  lineValue(): string | null {
    const l = this.values().line;
    if (!l) return null;
    if (!l.linked) return $localize`:@@group.value.lineNotLinked:ยังไม่เชื่อม`;
    return this.paid() ? $localize`:@@group.value.lineLinked:เชื่อมแล้ว` : $localize`:@@group.value.linePaused:หยุดชั่วคราว`;
  }

  advancedValue(): string | null {
    const a = this.values().advanced;
    if (!a) return null;
    const on = Number(a.shuttleTools) + Number(a.crossSessionHistory);
    if (on === 0) return $localize`:@@group.value.allOff:ปิดทั้งหมด`;
    // Stored on, but a free owner's new rounds snapshot both off: say so rather than "on".
    if (!this.paid()) return $localize`:@@group.row.inactiveBadge:ปิดในแพ็ก⁠เกจฟรี`;
    if (on === 2) return $localize`:@@group.value.allOn:เปิดทั้งหมด`;
    return $localize`:@@group.value.oneOn:เปิด 1 จาก 2`;
  }

  /** On = something switched on: shown in the court-soft tint rather than neutral. */
  isOn(section: SettingsSection): boolean {
    const v = this.values();
    if (section === 'levels') return v.levels?.mode === 'custom';
    if (section === 'share') return v.shared === true;
    if (section === 'line') return this.paid() && v.line?.linked === true;
    if (section === 'advanced') {
      return this.paid() && !!v.advanced && (v.advanced.shuttleTools || v.advanced.crossSessionHistory);
    }
    return false;
  }

  /**
   * A row is locked only on a known free plan, and only when its page holds nothing a free
   * host can do: no share link to stop, no switch to turn off, no custom ladder to look at. A
   * fact still loading, or failed, leaves the row a link — never trap a host out of cleaning up.
   * Players and manage are never disabled.
   */
  locked(section: SettingsSection): boolean {
    if (this.paid()) return false;
    const v = this.values();
    if (section === 'levels') return v.levels?.mode === 'standard';
    if (section === 'share') return v.shared === false;
    // Locked only when there is nothing to take down: a linked group keeps its row so Unlink stays reachable.
    if (section === 'line') return v.line?.linked === false;
    if (section === 'advanced') return !!v.advanced && !v.advanced.shuttleTools && !v.advanced.crossSessionHistory;
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
    // The row reads "connected" when either way is on: the LINE group, or DM capture for this group.
    this.lineService.status(code).subscribe({
      next: (s) => {
        set({ line: { linked: s.linked } });
        this.lineService.hostStatus(code).subscribe({
          next: (h) => set({ line: { linked: s.linked || h.enabled } }),
          error: ignore,
        });
      },
      error: ignore,
    });
    Promise.all([firstValueFrom(this.roster.getShuttleTools(code)), firstValueFrom(this.roster.getCrossSessionHistory(code))])
      .then(([shuttle, history]) =>
        set({ advanced: { shuttleTools: shuttle.enabled, crossSessionHistory: history.enabled } })
      )
      .catch(ignore);
  }
}
