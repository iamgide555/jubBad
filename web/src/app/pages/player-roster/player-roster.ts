import { DecimalPipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, OnDestroy, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { CanComponentDeactivate } from '../../core/can-deactivate.guard';
import { RosterService, type ManagedPlayer } from '../../core/roster.service';
import {
  RULE_KINDS,
  ruleErrorMessage,
  type CreatePairRuleRequest,
  type PairRule,
  type RuleKind,
} from '../../core/pair-rule.model';
import { AddRuleDialog } from '../../shared/add-rule-dialog/add-rule-dialog';
import { LevelPicker } from '../../shared/level-picker/level-picker';
import type { Level } from '../../../../../engines/levels.ts';
import { levelRank, levelsErrorMessage, type GroupLevelsResponse } from '../../core/group-levels.model';

type SortKey = 'rating' | 'singlesRating' | 'winRate' | 'level';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9+\- ]{6,20}$/;

@Component({
  selector: 'app-player-roster',
  imports: [FormsModule, RouterLink, DecimalPipe, LevelPicker, AddRuleDialog],
  templateUrl: './player-roster.html',
  styleUrl: './player-roster.css',
})
export class PlayerRoster implements CanComponentDeactivate, OnDestroy {
  private readonly rosterService = inject(RosterService);

  readonly groupCode: string;
  readonly players = signal<ManagedPlayer[]>([]);
  readonly loaded = signal(false);
  readonly loadError = signal(false);

  // Rank always reflects whichever metric is currently sorted, not a fixed
  // column — see the design spec's "Frontend" section.
  readonly sortKey = signal<SortKey>('rating');

  readonly sortedPlayers = computed(() => {
    const key = this.sortKey();
    // 'level' is a name in the group's own ladder, not a number —
    // compared by its position in that ladder (levelRank) rather than the
    // generic numeric subtraction the other three metrics share.
    if (key === 'level') {
      return [...this.players()].sort((a, b) => {
        if (a.level === null && b.level === null) return 0;
        if (a.level === null) return 1; // nulls (no level yet) sort last
        if (b.level === null) return -1;
        const ladder = this.ladder()?.levels ?? [];
        return levelRank(ladder, b.level) - levelRank(ladder, a.level); // descending, by the group's own order
      });
    }
    return [...this.players()].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (av === null && bv === null) return 0;
      if (av === null) return 1; // nulls sort last regardless of metric
      if (bv === null) return -1;
      return bv - av; // descending
    });
  });

  constructor(route: ActivatedRoute) {
    this.groupCode = route.snapshot.paramMap.get('groupCode')!;
    void this.load(true);
    void this.loadLadder();
    // Covers the navigation paths canDeactivate() cannot: closing the tab,
    // reloading, or typing a new URL — none of which run the Angular
    // Router's guards, since the app itself is about to unload.
    window.addEventListener('beforeunload', this.beforeUnloadHandler);
  }

  ngOnDestroy(): void {
    window.removeEventListener('beforeunload', this.beforeUnloadHandler);
  }

  private readonly beforeUnloadHandler = (event: BeforeUnloadEvent): void => {
    if (this.editingId() === null) return;
    event.preventDefault();
    event.returnValue = '';
  };

  /**
   * Runs on every attempt to navigate away via the Angular Router —
   * browser back/forward, a typed URL that still resolves to a route in
   * this app, or any in-template link — regardless of whether the link
   * itself was disabled. The in-template back-link swap (see the template)
   * is a visual cue only; this is what actually stops the navigation.
   */
  canDeactivate(): boolean {
    if (this.editingId() === null) return true;
    return window.confirm(
      $localize`:@@playerRoster.confirmDiscard:คุณกำลังแก้ไขข้อมูลผู้เล่นอยู่ ออกจากหน้านี้โดยไม่บันทึกใช่หรือไม่?`
    );
  }

  private async load(withRules = false): Promise<void> {
    try {
      const [players, rules] = await Promise.all([
        firstValueFrom(this.rosterService.getPlayersManage(this.groupCode)),
        withRules ? firstValueFrom(this.rosterService.getRules(this.groupCode)) : null,
      ]);
      this.players.set(players);
      if (rules) this.rules.set(rules);
      this.loadError.set(false);
    } catch {
      this.loadError.set(true);
    } finally {
      this.loaded.set(true);
    }
  }

  readonly ruleKinds = RULE_KINDS;
  readonly rules = signal<PairRule[]>([]);
  readonly rulesError = signal<string | null>(null);
  /** The rules list sits above the player table, collapsed; adding one opens it. */
  readonly rulesOpen = signal(false);

  private readonly addRuleDialog = viewChild<AddRuleDialog>('addRuleDialog');
  readonly addRuleSaving = signal(false);
  readonly addRuleError = signal<string | null>(null);

  openAddRuleDialog(): void {
    this.addRuleError.set(null);
    this.addRuleDialog()?.open();
  }

  playerName(id: string): string {
    return this.players().find((p) => p.id === id)?.name ?? '?';
  }

  /** Creates the rule from the shared add-rule modal; a refusal stays in the modal. */
  async submitAddRule(rule: CreatePairRuleRequest): Promise<void> {
    this.addRuleSaving.set(true);
    this.addRuleError.set(null);
    try {
      const created = await firstValueFrom(this.rosterService.createRule(this.groupCode, rule));
      this.rules.update((list) => [...list, created]);
      this.rulesOpen.set(true);
      this.addRuleDialog()?.close();
    } catch (err) {
      this.addRuleError.set(ruleErrorMessage(err));
    } finally {
      this.addRuleSaving.set(false);
    }
  }

  async setRuleKind(rule: PairRule, kind: RuleKind): Promise<void> {
    if (rule.kind === kind) return;
    this.rulesError.set(null);
    this.rules.update((list) => list.map((r) => (r.id === rule.id ? { ...r, kind } : r)));
    try {
      const saved = await firstValueFrom(this.rosterService.setRuleKind(this.groupCode, rule.id, kind));
      this.rules.update((list) => list.map((r) => (r.id === rule.id ? saved : r)));
    } catch (err) {
      this.rules.update((list) => list.map((r) => (r.id === rule.id ? rule : r)));
      this.rulesError.set(ruleErrorMessage(err));
    }
  }

  async deleteRule(rule: PairRule): Promise<void> {
    this.rulesError.set(null);
    try {
      await firstValueFrom(this.rosterService.deleteRule(this.groupCode, rule.id));
      this.rules.update((list) => list.filter((r) => r.id !== rule.id));
    } catch (err) {
      this.rulesError.set(ruleErrorMessage(err));
    }
  }

  setSortKey(key: SortKey): void {
    this.sortKey.set(key);
  }

  readonly levelSaveError = signal<string | null>(null);

  /** The group's ordered ladder; null while unread or unreadable, which disables level choices. */
  readonly ladder = signal<GroupLevelsResponse | null>(null);

  private async loadLadder(): Promise<void> {
    try {
      this.ladder.set(await firstValueFrom(this.rosterService.getGroupLevels(this.groupCode)));
    } catch {
      this.ladder.set(null);
    }
  }

  async setLevel(player: ManagedPlayer, level: Level | null): Promise<void> {
    const revision = this.ladder()?.revision;
    if (revision === undefined) return;
    const previous = player.level;
    this.players.update((list) =>
      list.map((p) => (p.id === player.id ? { ...p, level } : p))
    );
    this.levelSaveError.set(null);
    try {
      await firstValueFrom(this.rosterService.updatePlayerLevel(this.groupCode, player.id, level, revision));
      // A level edit resets the player's Elo seed (RatingAnchor, see
      // overview.md "Ratings"), so rating/singlesRating/winRate are stale
      // on every row, not just this one — reload the whole list rather
      // than patching just the level field.
      await this.load();
    } catch (err) {
      this.players.update((list) =>
        list.map((p) => (p.id === player.id ? { ...p, level: previous } : p))
      );
      const code = err instanceof HttpErrorResponse && typeof err.error?.code === 'string' ? err.error.code : null;
      this.levelSaveError.set(levelsErrorMessage(code) ?? $localize`:@@playerRoster.levelSaveFailed:บันทึกระดับไม่สำเร็จ`);
      // A stale answer means the ladder moved: read it again so the next choice is made from it.
      await this.loadLadder();
    }
  }

  // ---- inline edit ----

  readonly editingId = signal<string | null>(null);
  readonly editName = signal('');
  readonly editAge = signal('');
  readonly editEmail = signal('');
  readonly editPhone = signal('');
  readonly editError = signal<string | null>(null);
  readonly editBusy = signal(false);

  startEdit(player: ManagedPlayer): void {
    this.editingId.set(player.id);
    this.editName.set(player.name);
    this.editAge.set(player.age === null ? '' : String(player.age));
    this.editEmail.set(player.email ?? '');
    this.editPhone.set(player.phone ?? '');
    this.editError.set(null);
  }

  cancelEdit(): void {
    this.editingId.set(null);
  }

  /** Client-side mirror of UpdatePlayerDto's rules — the server is the source of truth. */
  private validate(): string | null {
    if (!this.editName().trim()) return $localize`:@@playerRoster.errNoName:กรุณาใส่ชื่อ`;
    const age = this.editAge().trim();
    if (age) {
      const n = Number(age);
      if (!Number.isInteger(n) || n < 0 || n > 120) {
        return $localize`:@@playerRoster.errBadAge:อายุต้องเป็นตัวเลข 0-120`;
      }
    }
    const email = this.editEmail().trim();
    if (email && !EMAIL_RE.test(email)) {
      return $localize`:@@playerRoster.errBadEmail:รูปแบบอีเมลไม่ถูกต้อง`;
    }
    const phone = this.editPhone().trim();
    if (phone && !PHONE_RE.test(phone)) {
      return $localize`:@@playerRoster.errBadPhone:รูปแบบเบอร์โทรไม่ถูกต้อง`;
    }
    return null;
  }

  async saveEdit(player: ManagedPlayer): Promise<void> {
    const error = this.validate();
    if (error) {
      this.editError.set(error);
      return;
    }

    this.editBusy.set(true);
    this.editError.set(null);
    try {
      const age = this.editAge().trim();
      const email = this.editEmail().trim();
      const phone = this.editPhone().trim();
      const updated = await firstValueFrom(
        this.rosterService.updatePlayer(this.groupCode, player.id, {
          name: this.editName().trim(),
          age: age ? Number(age) : undefined,
          email: email || undefined,
          phone: phone || undefined,
        })
      );
      this.players.update((list) =>
        list.map((p) => (p.id === player.id ? { ...p, ...updated } : p))
      );
      this.editingId.set(null);
    } catch {
      this.editError.set($localize`:@@playerRoster.saveFailed:บันทึกไม่สำเร็จ`);
    } finally {
      this.editBusy.set(false);
    }
  }
}
