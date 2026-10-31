import { HttpClient } from '@angular/common/http';
import { Icon } from '../../shared/icon/icon';
import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { groupCountLabel, groupLimitMessage, type MyPlan } from '../../core/plan';
import { PlanService } from '../../core/plan.service';
import { UpgradeSheetService } from '../../core/upgrade-sheet.service';
import { PlanLock } from '../../shared/plan-lock/plan-lock';
import { environment } from '../../../environments/environment';

export interface GroupSummary {
  code: string;
  name: string | null;
  sessionCount: number;
  playerCount: number;
  lastSessionCode: string | null;
  lastSessionAt: string | null;
  /** Past the owner's plan cap: kept and readable, but it cannot start a new round. */
  paused?: boolean;
  /** Admin responses only. A host's response has neither field. */
  mine?: boolean;
  ownerEmail?: string | null;
}

export interface OwnerGroups {
  /** null: a group nobody owns. */
  ownerEmail: string | null;
  groups: GroupSummary[];
}

/**
 * The admin's home. Until now this page could only mint a new group, so a group
 * was reachable solely by its bookmarked URL — lose the bookmark and the group
 * was gone, since nothing in the API could enumerate them.
 */
@Component({
  selector: 'app-landing',
  imports: [FormsModule, NgTemplateOutlet, RouterLink, PlanLock, Icon],
  templateUrl: './landing.html',
  styleUrl: './landing.css',
})
export class Landing {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly base = environment.apiBaseUrl;
  private readonly planService = inject(PlanService);
  protected readonly upgradeSheet = inject(UpgradeSheetService);

  /** The signed-in user's plan, group count and cap. Unknown (loading, failed) never blocks creating. */
  private readonly mine = signal<MyPlan | null>(null);
  /** At the cap: the create control says so up front instead of failing after a name is typed. */
  protected readonly atCap = computed(() => {
    const m = this.mine();
    return m !== null && m.groupLimit !== null && m.groupCount >= m.groupLimit;
  });
  /** At the cap on a plan that is already Host or above: nothing to upgrade to here, so no pitch. */
  protected readonly capIsPaid = computed(() => this.mine()?.plan !== 'free');
  protected readonly capLabel = computed(() => {
    const m = this.mine();
    return m && m.groupLimit !== null ? groupCountLabel(m.groupCount, m.groupLimit) : '';
  });
  protected readonly capHint = computed(() => {
    const m = this.mine();
    return m && m.groupLimit !== null ? groupLimitMessage(m.groupLimit) : null;
  });

  readonly groups = signal<GroupSummary[]>([]);
  readonly loaded = signal(false);
  readonly loadError = signal(false);

  /**
   * Only an admin's response says `mine: false`; for a host every group is
   * theirs. The admin's home is their own list, like any host's, and other
   * hosts' groups sit behind a collapsed row.
   */
  readonly mineGroups = computed(() => this.groups().filter((g) => g.mine !== false));
  readonly otherCount = computed(() => this.groups().filter((g) => g.mine === false).length);
  readonly othersOpen = signal(false);

  /** One entry per host, by email, ownerless last. */
  readonly otherGroups = computed<OwnerGroups[]>(() => {
    const byOwner = new Map<string | null, GroupSummary[]>();
    for (const g of this.groups().filter((x) => x.mine === false)) {
      const key = g.ownerEmail ?? null;
      byOwner.set(key, [...(byOwner.get(key) ?? []), g]);
    }
    return [...byOwner.entries()]
      .map(([ownerEmail, groups]) => ({ ownerEmail, groups }))
      .sort((a, b) =>
        a.ownerEmail === null ? 1 : b.ownerEmail === null ? -1 : a.ownerEmail.localeCompare(b.ownerEmail),
      );
  });

  toggleOthers(): void {
    this.othersOpen.update((open) => !open);
  }

  readonly removingCode = signal<string | null>(null);
  readonly removeConfirmText = signal('');
  readonly removeError = signal<string | null>(null);

  // Populated as a side effect of adminGuard's auth.check() before this page
  // ever renders (see app.routes.ts), so this is never stale on first paint.
  readonly isAdmin = computed(() => this.auth.role() === 'admin');

  constructor() {
    void this.load();
    void this.loadMine();
  }

  private async loadMine(): Promise<void> {
    try {
      this.mine.set(await firstValueFrom(this.planService.mine()));
    } catch {
      // Unknown plan: the ordinary create button; the server still refuses past the cap.
    }
  }

  private async load(): Promise<void> {
    try {
      this.groups.set(await firstValueFrom(this.http.get<GroupSummary[]>(`${this.base}/groups`)));
      this.loadError.set(false);
    } catch {
      this.loadError.set(true);
    } finally {
      this.loaded.set(true);
    }
  }

  retryLoad(): void {
    this.loaded.set(false);
    void this.load();
  }

  /** The group is saved by name first; the code is minted on the creation screen. */
  startNewGroup(): void {
    this.router.navigateByUrl('/groups/new');
  }

  startRemove(group: GroupSummary): void {
    this.removingCode.set(group.code);
    this.removeConfirmText.set('');
    this.removeError.set(null);
  }

  cancelRemove(): void {
    this.removingCode.set(null);
    this.removeConfirmText.set('');
  }

  /**
   * Same rule as the group's own danger zone: type the name. Deleting a group
   * takes every session, player and match with it and there is no undo, so the
   * guard is deliberately something you cannot do by reflex — and it is the
   * same gesture in both places rather than two different confirmations for one
   * irreversible act.
   */
  readonly canRemove = computed(() => {
    const group = this.groups().find((g) => g.code === this.removingCode());
    const expected = group?.name?.trim() ?? '';
    return expected.length > 0 && this.removeConfirmText().trim() === expected;
  });

  async confirmRemove(): Promise<void> {
    const code = this.removingCode();
    if (!code || !this.canRemove()) return;

    try {
      await firstValueFrom(this.http.delete(`${this.base}/groups/${code}`));
      this.groups.update((groups) => groups.filter((g) => g.code !== code));
      this.cancelRemove();
      // Deleting can release a paused group and changes the count against the cap: re-read both.
      void this.load();
      void this.loadMine();
    } catch {
      this.removeError.set($localize`:@@home.removeFailed:ลบก๊วนไม่สำเร็จ`);
    }
  }

  async signOut(): Promise<void> {
    await this.auth.logout();
    this.router.navigateByUrl('/login');
  }
}
