import { Component, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { parseLineRosterMessage } from '../../../../../parser.ts';
import { buildReviews, resolveReviews, type NameReview } from '../../core/roster-review';
import { RosterService } from '../../core/roster.service';
import { resolvePlayerNames } from '../../core/player-names';
import type { Session } from '../../core/session.model';
import type { Player } from '../../../../../fuzzy-match.ts';

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
    const group = this.rosterService.getGroup(this.groupCode);
    this.groupName.set(group?.name ?? '');
    this.lastSessionCode.set(group?.lastSessionCode ?? null);
  }

  saveGroupName(): void {
    const existing = this.rosterService.getGroup(this.groupCode);
    this.rosterService.saveGroup({
      code: this.groupCode,
      name: this.groupName() || null,
      lastSessionCode: existing?.lastSessionCode ?? null,
    });
  }

  playerName(id: string): string {
    return resolvePlayerNames([id], this.players)[0];
  }

  parse(): void {
    this.pasteError.set(null);

    if (!this.groupName().trim()) {
      this.pasteError.set('Please enter a group name first.');
      return;
    }
    if (!this.rawText().trim()) {
      this.pasteError.set('Paste a roster message first.');
      return;
    }

    const result = parseLineRosterMessage(this.rawText());
    const rosterNames = result.roster
      .map((slot) => slot.name)
      .filter((name): name is string => name !== null);

    if (rosterNames.length === 0) {
      this.pasteError.set(
        'No players were recognized — check that each name is on its own numbered line (e.g. "1. name").'
      );
      return;
    }

    this.date.set(result.header.isoDate ?? '');
    this.venue.set(result.header.venue ?? '');
    this.courtCount.set(result.header.timeSlots[0]?.courtCount ?? null);
    this.warnings.set(result.warnings);
    this.unrecognizedLines.set(result.unrecognizedLines);

    this.players = this.rosterService.getPlayers(this.groupCode);
    const waitlistNames = result.waitlist
      .map((slot) => slot.name)
      .filter((name): name is string => name !== null);

    this.rosterReviews.set(buildReviews(rosterNames, this.players));
    this.waitlistReviews.set(buildReviews(waitlistNames, this.players));

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
      venue: this.venue().trim() || null,
      courtCount: this.courtCount(),
      rawImportText: this.rawText(),
      rosterPlayerIds: roster.playerIds,
      waitlistPlayerIds: waitlist.playerIds,
    };
    this.rosterService.createSession(session);

    const existingGroup = this.rosterService.getGroup(this.groupCode);
    this.rosterService.saveGroup({
      code: this.groupCode,
      name: existingGroup?.name ?? null,
      lastSessionCode: session.code,
    });

    this.router.navigateByUrl(`/s/${session.code}`);
  }
}
