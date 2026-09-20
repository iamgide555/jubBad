import { similarity } from '../../../../engines/fuzzy-match.ts';
import type { NameMatch, Player, RosterNameMatch } from '../../../../engines/fuzzy-match.ts';

export interface NameReview {
  inputName: string;
  match: NameMatch;
  decision: 'accept' | 'reject-new';
}

/**
 * Everything defaults to `accept` — the host confirms the whole list in one
 * tap — except a `duplicate` or a `fuzzy` suggestion, either of which defaults
 * to being its own new player.
 *
 * "ตั้ม (1)" / "ตั้ม (2)" is two people far more often than it is one name
 * pasted twice, and a fuzzy hit (e.g. a shortened nickname) is only ever a
 * guess, not evidence. In both cases the two mistakes are not
 * symmetric: a spurious extra player is visible and editable afterwards,
 * while two people merged into one silently share a rating and a partner
 * history that can no longer be pulled apart. So "same person" is the
 * deliberate tap, not the default — a host who confirms the list without
 * reading every row ends up with an extra player to merge later, never a
 * wrong silent merge.
 */
export function attachDecisions(reviews: RosterNameMatch[]): NameReview[] {
  return reviews.map((r) => ({
    ...r,
    decision:
      r.match.type === 'duplicate' || r.match.type === 'fuzzy'
        ? ('reject-new' as const)
        : ('accept' as const),
  }));
}

/**
 * Manual roster add — search-existing-or-stage-new support for the review
 * screen. Everything here is client-only bookkeeping on top of the existing
 * `NameReview` shape; nothing here changes the wire contract.
 */

/**
 * Comparison key for "is this literally the same typed name" — trimmed,
 * Unicode NFC-normalized, case-insensitive. Deliberately does NOT strip a
 * trailing parenthetical note the way `normalizeName` does: "ตั้ม (2)" must
 * stay distinguishable from "ตั้ม", both for search ranking (see
 * `searchCandidates`) and for literal duplicate-draft detection (see
 * `literalNewNameDrafts`) — collapsing the label is exactly the silent-merge
 * failure mode this feature must not introduce.
 */
export function literalKey(name: string): string {
  return name.trim().normalize('NFC').toLowerCase();
}

/**
 * Union of existing player IDs already accepted by either review list —
 * imported or manual, no distinction. A manual "add existing" action is
 * itself just an accepted exact `NameReview`, so it falls out of this
 * computation for free. Only `exact`/`fuzzy`/`duplicate` accepted rows carry
 * a `playerId`; `new` rows don't claim anyone.
 *
 * A rejected fuzzy/duplicate suggestion does not reserve its playerId — only
 * `decision === 'accept'` counts.
 */
export function claimedPlayerIds(
  rosterReviews: NameReview[],
  waitlistReviews: NameReview[]
): Set<string> {
  const claimed = new Set<string>();
  for (const review of [...rosterReviews, ...waitlistReviews]) {
    if (review.decision === 'accept' && review.match.type !== 'new') {
      claimed.add(review.match.playerId);
    }
  }
  return claimed;
}

/**
 * True when a review is currently showing as a new-player row — mirrors the
 * template's own display rule (`group-entry.html`'s `#reviewRow`): a `new`
 * match is always new, and any other match type displays as new the moment
 * its decision is `reject-new` ("ไม่ใช่ เพิ่มใหม่" / "คนละคน"), even though
 * `match.type`/`playerId` are left untouched. A `new` review's decision is
 * always `accept` in practice — the template never renders a toggle for it —
 * but this reads correctly either way.
 */
function isEffectivelyNew(review: NameReview): boolean {
  return review.match.type === 'new' || review.decision === 'reject-new';
}

/**
 * Literal (folded) names already staged as new, across both lists —
 * covering both an accepted `new` match and any exact/fuzzy/duplicate match
 * the host rejected (which the review screen also displays and submits as a
 * new player; see `isEffectivelyNew`). Rows come from parsing or from an
 * earlier manual "add as new" alike. Used to block a second literal draft of
 * the same name; per the plan, this guard applies only to the manual control
 * going forward, never retroactively to existing imported rows.
 */
export function literalNewNameDrafts(
  rosterReviews: NameReview[],
  waitlistReviews: NameReview[]
): Set<string> {
  const drafts = new Set<string>();
  for (const review of [...rosterReviews, ...waitlistReviews]) {
    if (isEffectivelyNew(review)) {
      drafts.add(literalKey(review.inputName));
    }
  }
  return drafts;
}

/**
 * A literal exact name/alias match against the full player list (not
 * pre-excluded by claim status) — used to decide whether "Add as new" is
 * even the right action, versus offering the existing player or reporting it
 * as already selected. Case-insensitive, NFC-normalized, parenthetical
 * preserved (see `literalKey`).
 */
export function exactPlayerMatch(query: string, players: Player[]): Player | null {
  const key = literalKey(query);
  if (!key) return null;
  return (
    players.find((player) => [player.name, ...player.aliases].some((c) => literalKey(c) === key)) ??
    null
  );
}

/** Distinguishes the three states the manual "add" affordance can be in. */
export type ManualMatchState =
  | { kind: 'no-match' }
  | { kind: 'exact-match-available'; player: Player }
  | { kind: 'exact-match-already-selected'; player: Player };

export type CandidateRank = 'exact' | 'prefix' | 'substring' | 'fuzzy';

export interface PlayerCandidate {
  player: Player;
  rank: CandidateRank;
  /** 1 for exact/prefix/substring; the raw similarity score for fuzzy. */
  score: number;
}

const RANK_ORDER: Record<CandidateRank, number> = { exact: 0, prefix: 1, substring: 2, fuzzy: 3 };

/**
 * Below this, a fuzzy suggestion is noise rather than a plausible "did you
 * mean" for the search box. Kept separate from `fuzzy-match.ts`'s own
 * threshold — that one gates parse-time auto-suggestion, this one only gates
 * whether an interactive search result list bothers showing a low-confidence
 * row at all; changing this never changes parse behavior.
 */
const SEARCH_FUZZY_THRESHOLD = 0.5;

function rankPlayer(foldedQuery: string, player: Player): PlayerCandidate | null {
  const candidateNames = [player.name, ...player.aliases];
  const folded = candidateNames.map(literalKey);

  if (folded.some((c) => c === foldedQuery)) return { player, rank: 'exact', score: 1 };
  if (folded.some((c) => c.startsWith(foldedQuery))) return { player, rank: 'prefix', score: 1 };
  if (folded.some((c) => c.includes(foldedQuery))) return { player, rank: 'substring', score: 1 };

  let bestScore = 0;
  for (const candidate of folded) {
    bestScore = Math.max(bestScore, similarity(foldedQuery, candidate));
  }
  if (bestScore >= SEARCH_FUZZY_THRESHOLD) return { player, rank: 'fuzzy', score: bestScore };

  return null;
}

/**
 * Ranked search results for the manual-add field: exact match first, then
 * prefix, then substring, then fuzzy suggestions (sorted by score). Callers
 * pass the IDs to exclude (see `claimedPlayerIds`) — an excluded player never
 * appears here, but a rejected fuzzy suggestion does not reserve its ID, so
 * recompute this whenever the review lists or the query change. Returns a
 * ranked list, not a single best guess, since a fuzzy hit is only ever a
 * suggestion the host must explicitly confirm.
 */
export function searchCandidates(
  query: string,
  players: Player[],
  excludedIds: ReadonlySet<string>
): PlayerCandidate[] {
  const foldedQuery = literalKey(query);
  if (!foldedQuery) return [];

  const results: PlayerCandidate[] = [];
  for (const player of players) {
    if (excludedIds.has(player.id)) continue;
    const hit = rankPlayer(foldedQuery, player);
    if (hit) results.push(hit);
  }

  return results.sort((a, b) => {
    const rankDiff = RANK_ORDER[a.rank] - RANK_ORDER[b.rank];
    if (rankDiff !== 0) return rankDiff;
    if (a.rank === 'fuzzy') return b.score - a.score;
    return a.player.name.localeCompare(b.player.name);
  });
}
