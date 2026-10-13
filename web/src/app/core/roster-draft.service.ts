import { Injectable } from '@angular/core';
import type { Player } from '../../../../engines/fuzzy-match.ts';
import type { NameReview } from './roster-review';

/**
 * Everything the roster screen needs to come back exactly as the host left it.
 * The two Sets hold the same NameReview objects as the review arrays, so object
 * identity — which GroupEntry uses to tell manual rows and open questions apart —
 * survives the round trip.
 */
export interface RosterDraft {
  state: 'paste' | 'confirm';
  rawText: string;
  date: string;
  venue: string;
  courtCount: number | null;
  warnings: string[];
  unrecognizedLines: string[];
  rosterReviews: NameReview[];
  waitlistReviews: NameReview[];
  players: Player[];
  manualReviews: Set<NameReview>;
  openReviews: Set<NameReview>;
  idempotencyKey: string | null;
}

/**
 * Keeps an unfinished roster alive while the host steps out to group settings
 * and back. Root-provided and in memory only, keyed by group code: the roster
 * route component is destroyed on navigation, so it cannot hold the draft
 * itself. A reload drops it, as before; nothing goes to localStorage.
 */
@Injectable({ providedIn: 'root' })
export class RosterDraftService {
  private readonly drafts = new Map<string, RosterDraft>();

  get(groupCode: string): RosterDraft | null {
    return this.drafts.get(groupCode) ?? null;
  }

  save(groupCode: string, draft: RosterDraft): void {
    this.drafts.set(groupCode, draft);
  }

  clear(groupCode: string): void {
    this.drafts.delete(groupCode);
  }

  /** Every group's draft — for sign-out, so the next host on this tab sees none of them. */
  clearAll(): void {
    this.drafts.clear();
  }
}
