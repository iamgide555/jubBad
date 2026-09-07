import { Component, computed, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { attachDecisions, type NameReview } from '../../core/roster-review';
import type { GroupSession } from '../../core/group-session.model';
import { RosterService } from '../../core/roster.service';
import { resolvePlayerNames } from '../../core/player-names';
import type { Player } from '../../../../../engines/fuzzy-match.ts';

@Component({
  selector: 'app-group-entry',
  imports: [FormsModule, RouterLink],
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

  private players: Player[] = [];
  private creationIdempotencyKey: string | null = null;

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

  decisionLabel(review: NameReview): string {
    // A duplicate asks a different question from a fuzzy suggestion. Fuzzy is
    // "did you mean this player?"; duplicate is "is this the same person as
    // the slot above?", where accepting removes a slot rather than adding one.
    // Sharing the yes/no wording made the destructive answer read as the
    // agreeable one.
    if (review.match.type === 'duplicate') {
      return review.decision === 'accept'
        ? $localize`:@@entry.decisionSamePerson:คนเดียวกัน`
        : $localize`:@@entry.decisionDifferentPerson:คนละคน`;
    }
    if (review.match.type === 'exact') {
      return review.decision === 'accept'
        ? $localize`:@@entry.decisionUseExisting:ใช้ผู้เล่นเดิม`
        : $localize`:@@entry.decisionNew:ไม่ใช่ เพิ่มใหม่`;
    }
    return review.decision === 'accept'
      ? $localize`:@@entry.decisionYes:ใช่`
      : $localize`:@@entry.decisionNew:ไม่ใช่ เพิ่มใหม่`;
  }

  playerName(id: string): string {
    return resolvePlayerNames([id], this.players)[0];
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
      this.players = await firstValueFrom(this.rosterService.getPlayers(this.groupCode));

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

  toggleDecision(review: NameReview): void {
    const flip = (reviews: NameReview[]) =>
      reviews.map((r) =>
        r === review
          ? { ...r, decision: (r.decision === 'accept' ? 'reject-new' : 'accept') as NameReview['decision'] }
          : r
      );
    this.rosterReviews.update(flip);
    this.waitlistReviews.update(flip);
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
