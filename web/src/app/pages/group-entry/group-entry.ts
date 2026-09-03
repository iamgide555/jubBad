import { Component, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { parseLineRosterMessage } from '../../../../../parser.ts';
import { buildReviews, type NameReview } from '../../core/roster-review';
import { RosterService } from '../../core/roster.service';

@Component({
  selector: 'app-group-entry',
  imports: [FormsModule],
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

  constructor(
    route: ActivatedRoute,
    private rosterService: RosterService
  ) {
    this.groupCode = route.snapshot.paramMap.get('groupCode')!;
  }

  parse(): void {
    const result = parseLineRosterMessage(this.rawText());
    this.date.set(result.header.isoDate ?? '');
    this.venue.set(result.header.venue ?? '');
    this.courtCount.set(result.header.timeSlots[0]?.courtCount ?? null);

    const players = this.rosterService.getPlayers(this.groupCode);
    const rosterNames = result.roster
      .map((slot) => slot.name)
      .filter((name): name is string => name !== null);
    const waitlistNames = result.waitlist
      .map((slot) => slot.name)
      .filter((name): name is string => name !== null);

    this.rosterReviews.set(buildReviews(rosterNames, players));
    this.waitlistReviews.set(buildReviews(waitlistNames, players));

    this.state.set('confirm');
  }

  canConfirm(): boolean {
    return this.date().length > 0 && this.courtCount() !== null && this.courtCount()! > 0;
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
}
