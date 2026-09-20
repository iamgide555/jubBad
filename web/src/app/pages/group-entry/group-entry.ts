import { Component, computed, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import {
  attachDecisions,
  claimedPlayerIds,
  exactPlayerMatch,
  literalKey,
  literalNewNameDrafts,
  searchCandidates,
  type ManualMatchState,
  type NameReview,
  type PlayerCandidate,
} from '../../core/roster-review';
import type { GroupSession } from '../../core/group-session.model';
import { RosterService } from '../../core/roster.service';
import { resolvePlayerNames } from '../../core/player-names';
import { PressDirective } from '../../core/motion/press.directive';
import { RevealDirective } from '../../core/motion/reveal.directive';
import { Icon } from '../../shared/icon/icon';
import type { Player } from '../../../../../engines/fuzzy-match.ts';

@Component({
  selector: 'app-group-entry',
  imports: [FormsModule, RouterLink, NgTemplateOutlet, PressDirective, RevealDirective, Icon],
  templateUrl: './group-entry.html',
  styleUrl: './group-entry.css',
})
export class GroupEntry {
  protected readonly groupCode: string;
  readonly state = signal<'paste' | 'confirm'>('paste');
  readonly rawText = signal('');
  readonly date = signal('');
  readonly venue = signal('');
  readonly courtCount = signal<number | null>(null);
  readonly rosterReviews = signal<NameReview[]>([]);
  readonly waitlistReviews = signal<NameReview[]>([]);
  readonly groupName = signal('');
  readonly lastSessionCode = signal<string | null>(null);
  readonly warnings = signal<string[]>([]);
  readonly unrecognizedLines = signal<string[]>([]);
  readonly pasteError = signal<string | null>(null);
  readonly renameError = signal<string | null>(null);
  readonly confirmError = signal<string | null>(null);
  readonly pastSessions = signal<GroupSession[]>([]);
  readonly showDanger = signal(false);
  readonly deleteConfirmText = signal('');
  readonly dangerError = signal<string | null>(null);
  readonly isParsing = signal(false);
  readonly isRenaming = signal(false);
  readonly isSubmitting = signal(false);

  /** Group's known players, loaded once by `parse()`; converted to a signal
   * so the manual-add search/candidate state below can be computed from it. */
  private readonly players = signal<Player[]>([]);
  private creationIdempotencyKey: string | null = null;

  /** Manual roster add — search field text (Task 2 binds this two-way). */
  readonly manualQuery = signal('');
  /** Manual roster add — surfaces a whitespace-only/duplicate-draft rejection. */
  readonly manualAddError = signal<string | null>(null);

  /**
   * Same tracking pattern as `openReviews` below: object identity, not a
   * field on `NameReview` — manual bookkeeping is client-only and must never
   * appear on the wire. A manual addition is otherwise a plain accepted
   * `NameReview`, indistinguishable from an imported one.
   */
  private readonly manualReviews = new Set<NameReview>();

  /** Existing player IDs already accepted by either list — imported or
   * manual, no distinction. Recomputed from the review signals, so removing
   * a manual addition (or flipping an imported decision) makes an ID
   * searchable again automatically. */
  readonly claimedIds = computed(() => claimedPlayerIds(this.rosterReviews(), this.waitlistReviews()));

  /** Ranked search results for the manual-add field, excluding already
   * claimed players. Empty when the query is blank. */
  readonly manualCandidates = computed<PlayerCandidate[]>(() =>
    searchCandidates(this.manualQuery(), this.players(), this.claimedIds())
  );

  /** Which of no-match / exact-match-available / exact-match-already-selected
   * the current query is in — drives whether Task 2's UI shows "Add as new",
   * "select existing", or "already selected". */
  readonly manualMatchState = computed<ManualMatchState>(() => {
    const query = this.manualQuery().trim();
    if (!query) return { kind: 'no-match' };
    const player = exactPlayerMatch(query, this.players());
    if (!player) return { kind: 'no-match' };
    return this.claimedIds().has(player.id)
      ? { kind: 'exact-match-already-selected', player }
      : { kind: 'exact-match-available', player };
  });

  /**
   * Which reviews are showing the open yes/no toggle right now, tracked by
   * object identity rather than as a field on NameReview — it is pure UI
   * state, never sent to the server. `fuzzy`/`duplicate` rows start in this
   * set (a real judgment call the host must make); `exact` rows don't
   * (already correct, nothing to decide). Any decision change replaces the
   * review with a new object (see `setDecision`), which drops it out of this
   * set automatically — so answering a question collapses it back down with
   * no separate "close" step, and reopening it via the small "change answer"
   * link is the only way back in.
   */
  private readonly openReviews = new Set<NameReview>();

  constructor(
    route: ActivatedRoute,
    private rosterService: RosterService,
    private router: Router
  ) {
    this.groupCode = route.snapshot.paramMap.get('groupCode')!;
    this.rosterService.getGroup(this.groupCode).subscribe({
      next: (group) => {
        this.groupName.set(group.name ?? '');
        this.lastSessionCode.set(group.lastSessionCode);
      },
      error: () => {
        // Brand-new group - nothing to prefill, stays at defaults.
      },
    });
    this.rosterService.listSessions(this.groupCode).subscribe({
      next: (sessions) => this.pastSessions.set(sessions),
      error: () => {
        // Same as above: a group that does not exist yet simply has none.
      },
    });
  }

  /**
   * Typing the group's name is the guard on an irreversible delete. A plain
   * confirm() dialog is too easy to dismiss by reflex, and there is no auth to
   * fall back on.
   */
  readonly canDelete = computed(
    () =>
      this.groupName().trim().length > 0 &&
      this.deleteConfirmText().trim() === this.groupName().trim()
  );

  async exportGroup(): Promise<void> {
    this.dangerError.set(null);
    try {
      const data = await firstValueFrom(this.rosterService.exportGroup(this.groupCode));
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `jubbad-${this.groupCode}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      this.dangerError.set($localize`:@@entry.exportFailed:ดาวน์โหลดไม่สำเร็จ`);
    }
  }

  async deleteGroup(): Promise<void> {
    if (!this.canDelete()) return;
    this.dangerError.set(null);
    try {
      await firstValueFrom(this.rosterService.deleteGroup(this.groupCode));
      this.router.navigateByUrl('/');
    } catch {
      this.dangerError.set($localize`:@@entry.deleteFailed:ลบก๊วนไม่สำเร็จ`);
    }
  }

  async saveGroupName(): Promise<void> {
    if (!this.groupName().trim() || this.isRenaming()) return;

    this.renameError.set(null);
    this.isRenaming.set(true);
    try {
      await firstValueFrom(this.rosterService.renameGroup(this.groupCode, this.groupName()));
    } catch {
      this.renameError.set($localize`:@@entry.renameFailed:บันทึกชื่อก๊วนไม่สำเร็จ`);
    } finally {
      this.isRenaming.set(false);
    }
  }

  /**
   * Labels the button for `decision`, not the review's current decision — the
   * template renders one button per choice so the host picks between two
   * visible options rather than reading one button's label to guess what
   * tapping it will do.
   *
   * A duplicate asks a different question from an exact/fuzzy suggestion.
   * Exact/fuzzy is "did you mean this player?"; duplicate is "is this the
   * same person as the slot above?", where accepting removes a slot rather
   * than adding one. Sharing the yes/no wording made the destructive answer
   * read as the agreeable one.
   */
  decisionLabel(review: NameReview, decision: NameReview['decision']): string {
    if (review.match.type === 'duplicate') {
      return decision === 'accept'
        ? $localize`:@@entry.decisionSamePerson:คนเดียวกัน`
        : $localize`:@@entry.decisionDifferentPerson:คนละคน`;
    }
    return decision === 'accept'
      ? $localize`:@@entry.decisionYes:ใช่`
      : $localize`:@@entry.decisionNew:ไม่ใช่ เพิ่มใหม่`;
  }

  playerName(id: string): string {
    return resolvePlayerNames([id], this.players())[0];
  }

  /**
   * The typed text ("เกีย") is what the host pasted, not what to show once
   * they've confirmed it is an existing player ("เกียร์") — showing the raw
   * paste after confirming the match just reads as if the confirmation did
   * nothing. `duplicate` keeps the typed text even when accepted: its tag
   * already names the player it merges into, and the row itself disappears
   * from the roster on submit rather than taking on that player's identity.
   */
  displayName(review: NameReview): string {
    if (review.decision === 'accept' && review.match.type === 'exact') {
      return this.playerName(review.match.playerId);
    }
    if (review.decision === 'accept' && review.match.type === 'fuzzy') {
      return this.playerName(review.match.playerId);
    }
    return review.inputName;
  }

  /**
   * `exact` starts closed (nothing to decide) and `fuzzy`/`duplicate` start
   * open (see `openReviews`); either way, this is what actually shows the
   * toggle right now, regardless of why.
   */
  isOpen(review: NameReview): boolean {
    return this.openReviews.has(review);
  }

  openChoice(review: NameReview): void {
    this.openReviews.add(review);
  }

  async parse(): Promise<void> {
    if (this.isParsing()) return;
    this.pasteError.set(null);

    if (!this.groupName().trim()) {
      this.pasteError.set($localize`:@@entry.errNoGroupName:กรุณาใส่ชื่อก๊วนก่อน`);
      return;
    }
    if (!this.rawText().trim()) {
      this.pasteError.set($localize`:@@entry.errNoText:วางข้อความรายชื่อก่อน`);
      return;
    }

    this.isParsing.set(true);
    try {
      const result = await firstValueFrom(
        this.rosterService.parseRoster(this.groupCode, this.groupName(), this.rawText())
      );

      if (result.rosterReviews.length === 0) {
        this.pasteError.set(
          $localize`:@@entry.errNoPlayers:ไม่พบรายชื่อผู้เล่น — ตรวจว่าแต่ละชื่ออยู่บรรทัดของตัวเองและมีเลขนำหน้า (เช่น "1. ชื่อ")`
        );
        return;
      }

      this.date.set(result.header.isoDate ?? '');
      this.venue.set(result.header.venue ?? '');
      this.courtCount.set(result.header.courtCount);
      this.warnings.set(result.warnings);
      this.unrecognizedLines.set(result.unrecognizedLines);

      this.rosterReviews.set(attachDecisions(result.rosterReviews));
      this.waitlistReviews.set(attachDecisions(result.waitlistReviews));
      this.openReviews.clear();
      for (const review of [...this.rosterReviews(), ...this.waitlistReviews()]) {
        if (review.match.type === 'fuzzy' || review.match.type === 'duplicate') {
          this.openReviews.add(review);
        }
      }
      this.players.set(await firstValueFrom(this.rosterService.getPlayers(this.groupCode)));

      // A successful reparse replaces the whole review, so any manual
      // additions/search state from a previous parse no longer refer to
      // anything real and must not carry over.
      this.manualReviews.clear();
      this.manualQuery.set('');
      this.manualAddError.set(null);

      this.state.set('confirm');
    } catch {
      this.pasteError.set($localize`:@@entry.parseFailed:อ่านรายชื่อไม่สำเร็จ กรุณาลองอีกครั้ง`);
    } finally {
      this.isParsing.set(false);
    }
  }

  canConfirm(): boolean {
    return (
      this.date().length > 0 &&
      this.courtCount() !== null &&
      this.courtCount()! > 0 &&
      this.rosterReviews().length > 0
    );
  }

  setDecision(review: NameReview, decision: NameReview['decision']): void {
    const apply = (reviews: NameReview[]) =>
      reviews.map((r) => (r === review ? { ...r, decision } : r));
    this.rosterReviews.update(apply);
    this.waitlistReviews.update(apply);
  }

  /**
   * A manual addition/removal is otherwise a plain `NameReview`,
   * indistinguishable from an imported row — this is the only way Task 2's
   * template can tell the two apart, e.g. to show remove/reselect instead of
   * the imported-name yes/no toggle.
   */
  isManualReview(review: NameReview): boolean {
    return this.manualReviews.has(review);
  }

  /**
   * Selects an existing player found via `manualCandidates`. Re-validates
   * eligibility at the moment of the call rather than trusting the rendered
   * list, so a rapid double-click/tap on a candidate that a first click just
   * claimed is a no-op instead of a double add. Always lands in the main
   * roster, never the waitlist (manual additions never go to the waitlist).
   */
  addExisting(playerId: string): void {
    if (this.isSubmitting()) return;
    if (this.claimedIds().has(playerId)) return;
    const player = this.players().find((p) => p.id === playerId);
    if (!player) return;

    const review: NameReview = {
      inputName: player.name,
      match: { type: 'exact', playerId },
      decision: 'accept',
    };
    this.rosterReviews.update((rs) => [...rs, review]);
    this.manualReviews.add(review);
    this.manualQuery.set('');
    this.manualAddError.set(null);
  }

  /**
   * Stages the current search text as a brand-new player (`match.type ===
   * 'new'`) — no player record or ID is created yet, that happens on the
   * server at confirmation. Rejects whitespace-only input and a literal
   * repeat of a draft already staged in either list. Re-checks for a live
   * exact player match as a defensive guard: an exact match should always be
   * offered/selected instead of creating a duplicate profile, even if this
   * is invoked past a stale render.
   */
  addNew(): void {
    if (this.isSubmitting()) return;
    this.manualAddError.set(null);

    const trimmed = this.manualQuery().trim();
    if (!trimmed) {
      this.manualAddError.set($localize`:@@entry.manualAddEmpty:กรุณาพิมพ์ชื่อก่อน`);
      return;
    }
    if (exactPlayerMatch(trimmed, this.players())) {
      this.manualAddError.set(
        $localize`:@@entry.manualAddExactExists:มีผู้เล่นชื่อนี้อยู่แล้ว กรุณาเลือกจากรายการ`
      );
      return;
    }
    const drafts = literalNewNameDrafts(this.rosterReviews(), this.waitlistReviews());
    if (drafts.has(literalKey(trimmed))) {
      this.manualAddError.set($localize`:@@entry.manualAddDuplicate:เพิ่มชื่อนี้ไปแล้ว`);
      return;
    }

    const review: NameReview = { inputName: trimmed, match: { type: 'new' }, decision: 'accept' };
    this.rosterReviews.update((rs) => [...rs, review]);
    this.manualReviews.add(review);
    this.manualQuery.set('');
  }

  /**
   * Removes a manual addition before confirmation. Manual additions only
   * ever land in `rosterReviews` (never the waitlist), so that's the only
   * list this touches. If it was an existing-player addition, the player
   * becomes searchable again automatically once removed — `claimedIds` is
   * derived from the review lists, not tracked separately — unless another
   * accepted row still references the same ID.
   */
  removeManual(review: NameReview): void {
    if (this.isSubmitting() || !this.manualReviews.has(review)) return;
    this.rosterReviews.update((rs) => rs.filter((r) => r !== review));
    this.manualReviews.delete(review);
  }

  async confirmRoster(): Promise<void> {
    if (this.isSubmitting() || !this.canConfirm()) return;

    this.confirmError.set(null);
    this.isSubmitting.set(true);
    this.creationIdempotencyKey ??= crypto.randomUUID();
    try {
      const result = await firstValueFrom(
        this.rosterService.createSession({
          groupCode: this.groupCode,
          date: this.date(),
          venue: this.venue().trim() || null,
          courtCount: this.courtCount(),
          rawImportText: this.rawText(),
          idempotencyKey: this.creationIdempotencyKey,
          rosterReviews: this.rosterReviews(),
          waitlistReviews: this.waitlistReviews(),
        })
      );
      await this.router.navigateByUrl(`/s/${result.code}`);
    } catch {
      this.confirmError.set($localize`:@@entry.createFailed:สร้างก๊วนไม่สำเร็จ กรุณาลองอีกครั้ง`);
    } finally {
      this.isSubmitting.set(false);
    }
  }
}
