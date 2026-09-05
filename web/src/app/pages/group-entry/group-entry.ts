import { Component, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { attachDecisions, type NameReview } from '../../core/roster-review';
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

  private players: Player[] = [];

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
  }

  saveGroupName(): void {
    if (!this.groupName().trim()) return;
    this.rosterService.renameGroup(this.groupCode, this.groupName()).subscribe();
  }

  decisionLabel(review: NameReview): string {
    return review.decision === 'accept'
      ? $localize`:@@entry.decisionYes:ใช่`
      : $localize`:@@entry.decisionNew:ไม่ใช่ เพิ่มใหม่`;
  }

  playerName(id: string): string {
    return resolvePlayerNames([id], this.players)[0];
  }

  async parse(): Promise<void> {
    this.pasteError.set(null);

    if (!this.groupName().trim()) {
      this.pasteError.set($localize`:@@entry.errNoGroupName:กรุณาใส่ชื่อก๊วนก่อน`);
      return;
    }
    if (!this.rawText().trim()) {
      this.pasteError.set($localize`:@@entry.errNoText:วางข้อความรายชื่อก่อน`);
      return;
    }

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
    const result = await firstValueFrom(
      this.rosterService.createSession({
        groupCode: this.groupCode,
        date: this.date(),
        venue: this.venue().trim() || null,
        courtCount: this.courtCount(),
        rawImportText: this.rawText(),
        rosterReviews: this.rosterReviews(),
        waitlistReviews: this.waitlistReviews(),
      })
    );

    this.router.navigateByUrl(`/s/${result.code}`);
  }
}
