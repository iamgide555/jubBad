import { Component, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { parseLineRosterMessage } from '../../../../../parser.ts';
import { buildReviews, resolveReviews, type NameReview } from '../../core/roster-review';
import { RosterService } from '../../core/roster.service';
import type { Session } from '../../core/session.model';

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
  readonly groupName = signal('');

  constructor(
    route: ActivatedRoute,
    private rosterService: RosterService,
    private router: Router
  ) {
    this.groupCode = route.snapshot.paramMap.get('groupCode')!;
    this.groupName.set(this.rosterService.getGroup(this.groupCode)?.name ?? '');
  }

  saveGroupName(): void {
    this.rosterService.saveGroup({ code: this.groupCode, name: this.groupName() || null });
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

  confirmRoster(): void {
    let players = this.rosterService.getPlayers(this.groupCode);

    const roster = resolveReviews(this.rosterReviews(), players);
    players = roster.players;
    const waitlist = resolveReviews(this.waitlistReviews(), players);
    players = waitlist.players;

    this.rosterService.savePlayers(this.groupCode, players);

    const session: Session = {
      code: crypto.randomUUID().slice(0, 8),
      groupCode: this.groupCode,
      date: this.date(),
      venue: this.venue() || null,
      courtCount: this.courtCount(),
      rawImportText: this.rawText(),
      rosterPlayerIds: roster.playerIds,
      waitlistPlayerIds: waitlist.playerIds,
    };
    this.rosterService.createSession(session);

    this.router.navigateByUrl(`/s/${session.code}`);
  }
}
