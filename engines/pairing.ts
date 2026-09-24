/**
 * Pairing/rotation engine: given a confirmed roster, court count, and
 * cross-session partner/opponent history, produces one round's court
 * assignments. See docs/overview.md, "How the engines think — Pairing".
 *
 * A court's size is 4 (doubles, two per team) or 2 (singles, one per team).
 * `courtCount` accepts either a plain number — "that many doubles courts",
 * kept for every existing caller and test — or a `number[]` of per-court
 * sizes in offer order. A bare number is exactly `Array(n).fill(4)`
 * internally, so nothing about the doubles-only path changes shape.
 */

import { ratingGap, type RatingTracks } from './elo.ts';
import { levelIndex, type Level } from './levels.ts';

export type PlayerId = string;
/** A team is 1 player (singles) or 2 (doubles). Both teams on a court are
 *  always the same size. */
export type Team = PlayerId[];
export type CourtSize = 2 | 4;

export function pairKey(a: PlayerId, b: PlayerId): string {
  return [a, b].sort().join('|');
}

/** Order-independent key for a group of players sharing a court, regardless of team split. */
export function groupKey(players: PlayerId[]): string {
  return [...players].sort().join('|');
}

/**
 * `random` is injected, so it is not always `Math.random`. A generator that
 * can return exactly 1 — many seeded ones can, and the tests supply their own
 * — makes `j` fall one past the end, and the swap then *grows* the array and
 * leaves a hole where a player should be. That hole reaches a court as a null
 * name rather than an error, which is the worst way for it to surface. Clamp
 * instead of trusting the contract.
 */
export function shuffle<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** A plain number means "that many doubles (4-player) courts" — the shape
 *  every pre-existing caller and test already passes. */
function normalizeSizes(courtCount: number | CourtSize[]): CourtSize[] {
  return Array.isArray(courtCount) ? courtCount : Array(courtCount).fill(4);
}

/**
 * The prefix of `sizes` that fits within `available` players, consumed in
 * order with no skipping: once a court's size no longer fits what's left,
 * neither it nor anything after it is offered a match this round. This is
 * the direct generalization of the old `Math.floor(roster.length / 4)` — that
 * was already "how many size-4 courts fit before running out," just for a
 * uniform size. Order is the caller's lever: `proposeExclusively` puts the
 * requested court first so it is never starved by others ahead of it, and
 * `fillExclusively` offers idle courts smallest-first so a short bench still
 * fills as many courts as it can.
 */
function consumedSizes(sizes: CourtSize[], available: number): CourtSize[] {
  const consumed: CourtSize[] = [];
  let used = 0;
  for (const size of sizes) {
    if (used + size > available) break;
    consumed.push(size);
    used += size;
  }
  return consumed;
}

export function selectSittingOut(
  roster: PlayerId[],
  courtCount: number | CourtSize[],
  gamesPlayedThisSession: Map<PlayerId, number>,
  random: () => number,
  /**
   * When each player's current wait began, as epoch milliseconds. Omitted, the
   * tie-break below vanishes and selection is games-then-random exactly as it
   * was before.
   */
  waitingSince?: Map<PlayerId, number>,
  /**
   * Groups that just played together. Only acted on when exactly one court is
   * being filled: with two or more, the grouping search downstream already
   * has room to keep a repeat quartet apart. With one, whoever this function
   * picks to play *is* the group — nothing downstream can fix it — so this is
   * where the single-court case has to be caught.
   */
  recentGroupKeys?: Set<string> | null,
  /** A player's skill level, for the ±1 band below. Omitted, selection is unchanged. */
  levels?: ReadonlyMap<PlayerId, Level | null>,
  /**
   * The ±1 level band (D4, soft-dominant): who plays is biased toward
   * clustering with same-level players, court by court, so the split search
   * downstream actually has same-level groups to work with. Off by default —
   * every existing caller is unaffected.
   */
  band = false
): { playing: PlayerId[]; sittingOut: PlayerId[] } {
  const sizes = normalizeSizes(courtCount);
  const offered = consumedSizes(sizes, roster.length);
  const usableCourts = offered.length;
  const sitOutCount = roster.length - offered.reduce((sum, s) => sum + s, 0);

  if (sitOutCount <= 0) {
    return { playing: [...roster], sittingOut: [] };
  }

  // Shuffle first, then sort. Array.prototype.sort is stable (ES2019 onward),
  // so players level on every criterion keep their shuffled order — that is
  // the whole random tiebreak. Swapping these two lines, or moving to an
  // unstable sort, silently makes "who sits out" a function of roster
  // position, and the same people sit every week.
  const shuffled = shuffle(roster, random);
  const sorted = [...shuffled].sort((a, b) => {
    const byGames = (gamesPlayedThisSession.get(b) ?? 0) - (gamesPlayedThisSession.get(a) ?? 0);
    if (byGames !== 0) return byGames;
    // Later start of wait means a shorter wait, so that player sits out first.
    // Everyone starts a session on the same value, so the opening round is
    // still decided purely at random.
    return (waitingSince?.get(b) ?? 0) - (waitingSince?.get(a) ?? 0);
  });

  // `sorted` is unchanged above: front sits out first (most games, then
  // shortest wait). The band, when on, only ever reorders *within* that
  // priority — clustering it around each court's anchor — so everything
  // below (the natural cut, and the single-court group-repeat swap) works on
  // whichever ordering it's handed without needing to know band is involved.
  const priorityOrder = band && levels ? bandOrderedByCourt(sorted, offered, levels) : sorted;

  const groupsFor = (sittingOut: PlayerId[]): { playing: PlayerId[]; sittingOut: PlayerId[] } => {
    const sittingOutSet = new Set(sittingOut);
    return { playing: roster.filter((p) => !sittingOutSet.has(p)), sittingOut };
  };

  const natural = groupsFor(priorityOrder.slice(0, sitOutCount));

  if (usableCourts !== 1 || !recentGroupKeys?.has(groupKey(natural.playing))) {
    return natural;
  }

  // Real waiting times are wall-clock timestamps and essentially never tie
  // exactly, so there is usually no genuine tie for a random tiebreak to
  // exploit — the fix has to perturb the selection itself, not reshuffle it.
  //
  // Swap the pair straddling the sit/play boundary: the player who *just*
  // made the cut to sit out, and the player who *just* made the cut to play.
  // That is the smallest possible change to who plays, tried at increasing
  // distance from the boundary only if a closer swap still reproduces a
  // recent group.
  const maxSwap = Math.min(sitOutCount, priorityOrder.length - sitOutCount);
  for (let k = 1; k <= maxSwap; k++) {
    const sittingOut = priorityOrder.slice(0, sitOutCount);
    sittingOut[sitOutCount - k] = priorityOrder[sitOutCount - 1 + k];
    const candidate = groupsFor(sittingOut);
    if (!recentGroupKeys.has(groupKey(candidate.playing))) {
      return candidate;
    }
  }

  return natural;
}

/**
 * Reorders `sorted` (front sits out first, same convention throughout) so
 * that each offered court, processed in order, is filled from whoever is
 * still unclaimed and closest in level to that court's anchor — the most
 * deserving unclaimed player. A greedy, per-court pass, not a globally
 * optimal one: it can still produce a worse split than some other choice of
 * who sits out (see docs/superpowers/specs, C1), but it never skips the
 * single most-deserving remaining player as an anchor, which is the fairness
 * bound the ±1 band promises — a rare level waits at most until it reaches
 * the front of the queue.
 *
 * Reordering is *not* limited to the caller's cut: an in-band player from the
 * sit-out side can take a court seat ahead of an out-of-band player with fewer
 * games. Only the anchor is guaranteed to play. The returned order keeps the
 * same convention (head sits, tail plays), so the caller's slice still works.
 */
function bandOrderedByCourt(
  sorted: PlayerId[],
  offered: CourtSize[],
  levels: ReadonlyMap<PlayerId, Level | null>
): PlayerId[] {
  let remaining = [...sorted].reverse(); // front = most deserving to play
  const chosenPerCourt: PlayerId[][] = [];

  for (const size of offered) {
    if (remaining.length === 0) break;
    // The band is checked against the court's running level range, not the
    // anchor alone: P- and P+ are each one from a P anchor but two from each
    // other, and `courtBreaksBand` scores exactly that court as broken.
    let min = Infinity;
    let max = -Infinity;
    const inBand: PlayerId[] = [];
    const outOfBand: PlayerId[] = [];
    for (const p of remaining) {
      const level = levels.get(p) ?? null;
      const index = level === null ? null : levelIndex(level);
      const fits =
        inBand.length < size &&
        (index === null || Math.max(max, index) - Math.min(min, index) <= 1);
      if (fits) {
        inBand.push(p);
        if (index !== null) {
          min = Math.min(min, index);
          max = Math.max(max, index);
        }
      } else {
        outOfBand.push(p);
      }
    }
    const chosen = [...inBand, ...outOfBand].slice(0, size);
    chosenPerCourt.push(chosen);
    const chosenSet = new Set(chosen);
    remaining = remaining.filter((p) => !chosenSet.has(p));
  }

  // Every chosen player still played, in the same deserving-first order as
  // before, so the boundary the caller inspects (the weakest included, the
  // strongest excluded) means the same thing it always did.
  const playing = chosenPerCourt.flat().reverse();
  const sittingOut = [...remaining].reverse();
  return [...sittingOut, ...playing];
}

export interface CourtAssignment {
  court: number;
  teamA: Team;
  teamB: Team;
}

/**
 * Repeat-partner avoidance is the primary goal; opponent balancing is only a
 * secondary soft signal. Variety-mode selection compares the two dimensions
 * lexicographically, while the numeric 10:1 score remains useful for
 * diagnostics and the combined balanced-mode objective. Making opponents a
 * hard constraint too would risk leaving a group with a lot of history
 * unsolvable — the namespace is small and dense.
 *
 * Both terms scale with how many times a pair has actually met, not whether
 * they ever have. A yes/no test looks equivalent and is not: every pair in a
 * 12-player group has partnered at least once by the second session, after
 * which a binary term scores every possible arrangement identically and stops
 * steering anything. Measured over ten sessions that left some pairs together
 * three times as often as others, which is exactly the "I always play with the
 * same person" complaint. Counting keeps the spread near one game.
 */
const PARTNER_WEIGHT = 10;
const OPPONENT_WEIGHT = 1;
/**
 * How much one rating point of imbalance costs, in balanced mode only. At 2, a
 * repeat partnership (10) is worth five rating points — so the engine will
 * accept playing with the same partner again to make a match five points
 * fairer. Balance leads, which is the whole reason for choosing this mode,
 * while variety still separates arrangements that are level on skill.
 *
 * Tuned by measurement, not taste. Over 40 sessions the previous weight left
 * an average gap of 212 when the search could reach 0 on the same players;
 * this brings it to about 90 with no measurable cost to partner variety, and
 * a four-player group — where only one split is balanced — still rotates
 * across splits rather than pinning to it.
 */
const BALANCE_WEIGHT = 2;

export interface HistoryFloors {
  partner: number;
  opponent: number;
}

/**
 * The least any pair among these players has partnered, and likewise faced
 * each other. Scoring the excess over that floor rather than the raw count is
 * what keeps the scale stable: a group where everyone has partnered everyone
 * forty times is perfectly varied, and should score the same as one on its
 * first night, not four hundred times worse. Without it every other constant
 * here quietly loses its meaning as a group accumulates history.
 */
export function historyFloors(
  players: PlayerId[],
  partnerCounts: Map<string, number>,
  opponentCounts: Map<string, number>
): HistoryFloors {
  let partner = Infinity;
  let opponent = Infinity;
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const key = pairKey(players[i], players[j]);
      partner = Math.min(partner, partnerCounts.get(key) ?? 0);
      opponent = Math.min(opponent, opponentCounts.get(key) ?? 0);
    }
  }
  return {
    partner: Number.isFinite(partner) ? partner : 0,
    opponent: Number.isFinite(opponent) ? opponent : 0,
  };
}

/**
 * Ratings for a single arrangement's balance term. Either a plain map — the
 * caller has already picked the one format in play, as every external call
 * site does — or both tracks, so a round mixing formats can pick the right
 * one per court. `ratingsMapFor` below is the only place that resolves which.
 */
export type RatingsInput = Map<PlayerId, number> | RatingTracks;

function ratingsMapFor(
  ratings: RatingsInput | undefined,
  teamSize: number
): Map<PlayerId, number> | undefined {
  if (!ratings) return undefined;
  if (ratings instanceof Map) return ratings;
  return teamSize === 1 ? ratings.singles : ratings.doubles;
}

export function scoreArrangement(
  courts: { teamA: Team; teamB: Team }[],
  partnerCounts: Map<string, number>,
  opponentCounts: Map<string, number>,
  ratings?: RatingsInput,
  floors: HistoryFloors = { partner: 0, opponent: 0 }
): number {
  const components = arrangementScoreComponents(
    courts,
    partnerCounts,
    opponentCounts,
    ratings,
    floors
  );
  return (
    components.partner * PARTNER_WEIGHT +
    components.opponent * OPPONENT_WEIGHT +
    components.balance * BALANCE_WEIGHT
  );
}

export interface ArrangementScoreComponents {
  /** Courts whose players (any split) match a group that recently played together. */
  groupRepeat: number;
  /** Courts containing two players more than one level apart (the ±1 band). */
  bandBreaks: number;
  partner: number;
  opponent: number;
  balance: number;
}

/**
 * Whether a court's players (any split) span more than one level. An unknown
 * level (null, or missing from the map) fits any level — it never counts
 * toward the spread — so a group with nobody tagged, or only one player
 * tagged, never breaks the band.
 */
function courtBreaksBand(players: PlayerId[], levels: ReadonlyMap<PlayerId, Level | null>): boolean {
  let min = Infinity;
  let max = -Infinity;
  for (const id of players) {
    const level = levels.get(id) ?? null;
    if (level === null) continue;
    const index = levelIndex(level);
    if (index < min) min = index;
    if (index > max) max = index;
  }
  return Number.isFinite(min) && max - min > 1;
}

export function arrangementScoreComponents(
  courts: { teamA: Team; teamB: Team }[],
  partnerCounts: Map<string, number>,
  opponentCounts: Map<string, number>,
  ratings?: RatingsInput,
  floors: HistoryFloors = { partner: 0, opponent: 0 },
  /** Groups (any split) that just played together and should not immediately reform. */
  recentGroupKeys?: Set<string> | null,
  /** Only when the ±1 band is on for this session; omitted, bandBreaks is always 0. */
  levels?: ReadonlyMap<PlayerId, Level | null>
): ArrangementScoreComponents {
  let groupRepeat = 0;
  let bandBreaks = 0;
  let partner = 0;
  let opponent = 0;
  let balance = 0;

  for (const { teamA, teamB } of courts) {
    const group = [...teamA, ...teamB];
    if (recentGroupKeys && recentGroupKeys.has(groupKey(group))) {
      groupRepeat += 1;
    }
    if (levels && courtBreaksBand(group, levels)) {
      bandBreaks += 1;
    }

    // Partner pairs: every within-team pair. A 1-player team (singles)
    // contributes none — there is no partner to repeat.
    for (const team of [teamA, teamB]) {
      for (let i = 0; i < team.length; i++) {
        for (let j = i + 1; j < team.length; j++) {
          const key = pairKey(team[i], team[j]);
          partner += Math.max(0, (partnerCounts.get(key) ?? 0) - floors.partner);
        }
      }
    }

    // Opponent pairs: the full cross product of the two teams. One pair for
    // singles, the same four as always for doubles.
    for (const a of teamA) {
      for (const b of teamB) {
        const key = pairKey(a, b);
        opponent += Math.max(0, (opponentCounts.get(key) ?? 0) - floors.opponent);
      }
    }

    // Only when ratings are supplied for this court's format. Without them
    // the term vanishes entirely, so variety mode (and a round with no
    // ratings at all) scores exactly as it always did.
    const ratingsMap = ratingsMapFor(ratings, teamA.length);
    if (ratingsMap) {
      balance += ratingGap(teamA, teamB, ratingsMap);
    }
  }

  return { groupRepeat, bandBreaks, partner, opponent, balance };
}

/**
 * Variety mode must never exchange an extra repeat partner for fewer repeat
 * opponents. Numeric weights cannot provide that guarantee once history grows
 * unbounded, so compare the two dimensions lexicographically. Balanced mode
 * intentionally keeps its combined rating-and-variety objective.
 *
 * `groupRepeat` — whether a court's players (any split) just played together
 * as a group — is compared before either mode's own objective, for the same
 * reason: a plain additive weight, however large, is eventually swamped as
 * partner/opponent counts accumulate over a season (the failure `avoidSplit`
 * already hit before it became a real exclusion). Comparing it first makes it
 * dominate regardless of how large those counts get, while still falling
 * through to the normal objective — including allowing a repeat — when every
 * candidate is level on it.
 */
export function compareArrangements(
  one: { teamA: Team; teamB: Team }[],
  other: { teamA: Team; teamB: Team }[],
  partnerCounts: Map<string, number>,
  opponentCounts: Map<string, number>,
  ratings?: RatingsInput,
  floors: HistoryFloors = { partner: 0, opponent: 0 },
  recentGroupKeys?: Set<string> | null,
  levels?: ReadonlyMap<PlayerId, Level | null>
): number {
  const first = arrangementScoreComponents(
    one,
    partnerCounts,
    opponentCounts,
    ratings,
    floors,
    recentGroupKeys,
    levels
  );
  const second = arrangementScoreComponents(
    other,
    partnerCounts,
    opponentCounts,
    ratings,
    floors,
    recentGroupKeys,
    levels
  );

  if (first.groupRepeat !== second.groupRepeat) return first.groupRepeat - second.groupRepeat;
  if (first.bandBreaks !== second.bandBreaks) return first.bandBreaks - second.bandBreaks;

  if (!ratings) {
    return first.partner - second.partner || first.opponent - second.opponent;
  }

  return (
    first.balance * BALANCE_WEIGHT +
    first.partner * PARTNER_WEIGHT +
    first.opponent * OPPONENT_WEIGHT -
    (second.balance * BALANCE_WEIGHT +
      second.partner * PARTNER_WEIGHT +
      second.opponent * OPPONENT_WEIGHT)
  );
}

export function buildRandomArrangement(
  playing: PlayerId[],
  usableCourts: number | CourtSize[],
  random: () => number
): CourtAssignment[] {
  const sizes = normalizeSizes(usableCourts);
  const shuffled = shuffle(playing, random);
  const courts: CourtAssignment[] = [];
  let offset = 0;
  for (let i = 0; i < sizes.length; i++) {
    const size = sizes[i];
    const group = shuffled.slice(offset, offset + size);
    offset += size;
    const half = size / 2;
    courts.push({
      court: i + 1,
      teamA: group.slice(0, half),
      teamB: group.slice(half),
    });
  }
  return courts;
}

export interface MatchHistory {
  /** All-time across sessions — variety over the group's whole life. */
  partnerCounts: Map<string, number>;
  /** All-time across sessions. */
  opponentCounts: Map<string, number>;
  /** This session only — resets each session for fair rotation today. */
  gamesPlayedThisSession: Map<PlayerId, number>;
  /**
   * When each player's current wait began, epoch milliseconds. Breaks ties
   * between players level on games so the longest wait goes on first, which
   * is the order the host already sees in the waiting list. Optional: without
   * it those ties fall back to random, the engine's original behaviour.
   */
  waitingSince?: Map<PlayerId, number>;
  /**
   * Keys (via `groupKey`) of groups that most recently played together,
   * across every court — not just the one a reshuffle commits. Optional:
   * without it, group-repeat avoidance is skipped entirely, the engine's
   * original behaviour.
   */
  recentGroupKeys?: Set<string>;
}

export interface RoundResult {
  courts: CourtAssignment[];
  sittingOut: PlayerId[];
}

/**
 * Random restarts feeding a local search, not blind sampling. Blind sampling
 * was measurably weak once the roster grew: with twelve players and three
 * courts there are 155,925 distinct arrangements, and 200 independent draws
 * found the optimum in none of 100 seeded runs. Restarts explore, the local
 * search exploits, and the exact path below removes the question entirely for
 * small rosters.
 */
const SEARCH_RESTARTS = 24;

/**
 * Restarts stop early once several in a row fail to beat the incumbent. Most
 * rounds converge almost immediately, and paying the full restart budget on
 * them made a six-court roster take roughly a fifth of a second per proposal
 * for no gain. Hard rounds still get the whole budget.
 */
const SEARCH_RESTART_PATIENCE = 12;

/**
 * A pass costs O(courts^2) swaps and each swap is scored in constant time, so
 * the cap only exists to bound pathological cycling. Real rounds converge in
 * a handful of passes.
 */
const MAX_IMPROVEMENT_PASSES = 40;

/**
 * Eight players over two doubles courts is 70 ordered court fillings times
 * nine team splits — small enough to enumerate outright and return a
 * provably optimal round. Twelve players is 155,925 before ordering, which is
 * not. Mixed-size rounds at the same player count are comparable or smaller
 * (e.g. eight players as [4,2,2] is 420 fillings before splits), so the same
 * threshold on `playing.length` still separates "enumerate exactly" from
 * "search" the way it always has.
 */
const EXACT_ENUMERATION_MAX_PLAYING = 8;

type Group = PlayerId[];

const splitPatternCache = new Map<number, [number[], number[]][]>();

/**
 * Every way to split a group of `size` players into two equal teams,
 * expressed as index pairs into the group. Index 0 is always fixed to teamA
 * to avoid enumerating the same split twice (A/B and B/A), and the remaining
 * teamA indices are chosen from what's left in increasing order — which for
 * size 4 reproduces the historical `SPLIT_PATTERNS` table
 * (`{0,1}|{2,3}`, `{0,2}|{1,3}`, `{0,3}|{1,2}`) exactly, in exactly that
 * order. For size 2 there is exactly one split: `{0}|{1}`.
 */
function splitPatternsFor(size: number): [number[], number[]][] {
  const cached = splitPatternCache.get(size);
  if (cached) return cached;

  const half = size / 2;
  const patterns: [number[], number[]][] = [];
  const rest = Array.from({ length: size - 1 }, (_, i) => i + 1);
  const combo: number[] = [];

  const choose = (start: number): void => {
    if (combo.length === half - 1) {
      const teamASet = new Set([0, ...combo]);
      const teamA = [0, ...combo];
      const teamB = Array.from({ length: size }, (_, i) => i).filter((i) => !teamASet.has(i));
      patterns.push([teamA, teamB]);
      return;
    }
    for (let i = start; i < rest.length; i++) {
      combo.push(rest[i]);
      choose(i + 1);
      combo.pop();
    }
  };
  choose(0);

  splitPatternCache.set(size, patterns);
  return patterns;
}

/**
 * The score is a sum over courts and every term reads only within-court pairs,
 * so a court's contribution is independent of the others. That is what makes
 * choosing each court's split separately exact rather than greedy, and it is
 * what keeps the local search below cheap.
 */
interface SearchContext {
  partnerCounts: Map<string, number>;
  opponentCounts: Map<string, number>;
  ratings?: RatingsInput;
  floors: HistoryFloors;
  /** Court 1 is the one a reshuffle commits, so only it can be constrained.
   *  Only ever set for a doubles (2-per-team) exclusion — a singles reshuffle
   *  routes its avoidance through `recentGroupKeys` instead (see
   *  `generateRound`), because a 2-player group has only one possible split
   *  and excluding it would leave no legal arrangement at all. */
  avoidKeys: Set<string> | null;
  /**
   * Groups that just played together, applied to every court — unlike
   * avoidKeys this is not limited to the committed court, because the bug it
   * guards against is specifically players regrouping onto a *different*
   * court once it frees up.
   */
  recentGroupKeys: Set<string> | null;
  /** Only set when the ±1 band is on for this session; otherwise bandBreaks stays 0. */
  levels?: ReadonlyMap<PlayerId, Level | null>;
}

function courtComponents(teamA: Team, teamB: Team, ctx: SearchContext): ArrangementScoreComponents {
  return arrangementScoreComponents(
    [{ teamA, teamB }],
    ctx.partnerCounts,
    ctx.opponentCounts,
    ctx.ratings,
    ctx.floors,
    ctx.recentGroupKeys,
    ctx.levels
  );
}

/** See the comment on compareArrangements: groupRepeat and bandBreaks are compared first, in both modes. */
function compareComponents(
  first: ArrangementScoreComponents,
  second: ArrangementScoreComponents,
  ratings?: RatingsInput
): number {
  if (first.groupRepeat !== second.groupRepeat) return first.groupRepeat - second.groupRepeat;
  if (first.bandBreaks !== second.bandBreaks) return first.bandBreaks - second.bandBreaks;
  if (!ratings) {
    return first.partner - second.partner || first.opponent - second.opponent;
  }
  return (
    first.balance * BALANCE_WEIGHT +
    first.partner * PARTNER_WEIGHT +
    first.opponent * OPPONENT_WEIGHT -
    (second.balance * BALANCE_WEIGHT +
      second.partner * PARTNER_WEIGHT +
      second.opponent * OPPONENT_WEIGHT)
  );
}

/**
 * `avoidKeys` is only ever built from a doubles (2-per-team) avoidSplit — see
 * `generateRound` — so this only makes sense for a size-2 team. The one call
 * site already guards on `teamA.length === 2` before calling this, but that
 * guard living only in the caller is a footgun: a future call site that
 * forgets to repeat it would hit `teamA[1]` as `undefined`, producing a bogus
 * key that can never match `avoidKeys` — the exclusion silently becomes a
 * no-op instead of failing loudly. Checked here too so this function is safe
 * on its own terms, not just as currently called.
 */
function isAvoidedSplit(teamA: Team, teamB: Team, avoidKeys: Set<string>): boolean {
  if (teamA.length !== 2 || teamB.length !== 2) return false;
  const keys = new Set([pairKey(teamA[0], teamA[1]), pairKey(teamB[0], teamB[1])]);
  return keys.size === avoidKeys.size && [...keys].every((key) => avoidKeys.has(key));
}

/**
 * The best legal split of one group, or null when every split is excluded or
 * scores NaN. Ties keep the first pattern, so a caller that randomizes group
 * order gets randomized tie-breaking for free — without that, an untouched
 * history would hand back the same pairing every single reshuffle.
 */
function bestSplitForGroup(
  group: Group,
  courtIndex: number,
  ctx: SearchContext
): { assignment: CourtAssignment; components: ArrangementScoreComponents } | null {
  let best: { assignment: CourtAssignment; components: ArrangementScoreComponents } | null = null;

  for (const [aIdx, bIdx] of splitPatternsFor(group.length)) {
    const teamA: Team = aIdx.map((i) => group[i]);
    const teamB: Team = bIdx.map((i) => group[i]);

    if (
      courtIndex === 0 &&
      ctx.avoidKeys &&
      teamA.length === 2 &&
      isAvoidedSplit(teamA, teamB, ctx.avoidKeys)
    ) {
      continue;
    }

    const components = courtComponents(teamA, teamB, ctx);
    const total =
      components.partner * PARTNER_WEIGHT +
      components.opponent * OPPONENT_WEIGHT +
      components.balance * BALANCE_WEIGHT;
    if (!Number.isFinite(total)) continue;

    if (!best || compareComponents(components, best.components, ctx.ratings) < 0) {
      best = { assignment: { court: courtIndex + 1, teamA, teamB }, components };
    }
  }

  return best;
}

/** Splits every group optimally. Null if any court has no legal, finite split. */
function bestArrangementForGroups(groups: Group[], ctx: SearchContext): CourtAssignment[] | null {
  const courts: CourtAssignment[] = [];
  for (let i = 0; i < groups.length; i++) {
    const best = bestSplitForGroup(groups[i], i, ctx);
    if (!best) return null;
    courts.push(best.assignment);
  }
  return courts;
}

function groupOf(court: CourtAssignment): Group {
  return [...court.teamA, ...court.teamB];
}

function totalComponents(parts: ArrangementScoreComponents[]): ArrangementScoreComponents {
  let groupRepeat = 0;
  let bandBreaks = 0;
  let partner = 0;
  let opponent = 0;
  let balance = 0;
  for (const part of parts) {
    groupRepeat += part.groupRepeat;
    bandBreaks += part.bandBreaks;
    partner += part.partner;
    opponent += part.opponent;
    balance += part.balance;
  }
  return { groupRepeat, bandBreaks, partner, opponent, balance };
}

/**
 * Steepest-descent local search over which players share a court. Splits are
 * already exact for a given grouping, so the only move that can improve a
 * round is exchanging two players across two courts.
 *
 * Scoring is incremental: a swap touches exactly two courts, and court scores
 * are independent, so a neighbour is evaluated by re-splitting those two and
 * reusing the rest. Rescoring the whole round instead cost roughly a second
 * per proposal on a twenty-four player, six-court roster.
 *
 * A 1-for-1 exchange preserves each court's player count regardless of
 * whether the two courts are the same size, so this works unchanged across a
 * mixed-format round: `x`/`y` are bounded by each group's own length, not a
 * fixed 4.
 */
function improveArrangement(start: CourtAssignment[], ctx: SearchContext): CourtAssignment[] {
  if (start.length < 2) return start;

  let courts = start.map((assignment) => ({
    assignment,
    components: courtComponents(assignment.teamA, assignment.teamB, ctx),
  }));

  for (let pass = 0; pass < MAX_IMPROVEMENT_PASSES; pass++) {
    const groups = courts.map((c) => groupOf(c.assignment));
    const current = totalComponents(courts.map((c) => c.components));

    let bestTotal = current;
    let bestMove: { i: number; j: number; left: typeof courts[number]; right: typeof courts[number] } | null =
      null;

    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        for (let x = 0; x < groups[i].length; x++) {
          for (let y = 0; y < groups[j].length; y++) {
            const left = [...groups[i]];
            const right = [...groups[j]];
            left[x] = groups[j][y];
            right[y] = groups[i][x];

            const leftBest = bestSplitForGroup(left, i, ctx);
            if (!leftBest) continue;
            const rightBest = bestSplitForGroup(right, j, ctx);
            if (!rightBest) continue;

            const candidate = totalComponents([
              current,
              leftBest.components,
              rightBest.components,
              negate(courts[i].components),
              negate(courts[j].components),
            ]);

            if (compareComponents(candidate, bestTotal, ctx.ratings) < 0) {
              bestTotal = candidate;
              bestMove = { i, j, left: leftBest, right: rightBest };
            }
          }
        }
      }
    }

    if (!bestMove) break;
    courts = [...courts];
    courts[bestMove.i] = bestMove.left;
    courts[bestMove.j] = bestMove.right;
  }

  return courts.map((c) => c.assignment);
}

function negate(components: ArrangementScoreComponents): ArrangementScoreComponents {
  return {
    groupRepeat: -components.groupRepeat,
    bandBreaks: -components.bandBreaks,
    partner: -components.partner,
    opponent: -components.opponent,
    balance: -components.balance,
  };
}

/**
 * Every ordered filling of the courts, for a given sequence of sizes.
 *
 * Two strategies, chosen once per call:
 *
 * - **Uniform sizes** (today's only case): the historical head-fixed chooser
 *   — the first remaining player is always folded into whichever group is
 *   being filled, and the rest of that group is chosen from what's left in
 *   increasing index order. Fixing the head removes the redundant work of
 *   enumerating a group's own members in every order, without losing any
 *   grouping, and produces exactly today's enumeration order for size 4.
 * - **Mixed sizes**: head-fixing is unsound here — it would force whichever
 *   player is first (after the caller's own shuffle) onto whatever court is
 *   filled first, so a partition where that player plays the *other* size
 *   court would never be generated. Instead every `size`-subset of what's
 *   left is tried at each position. Cost stays small at these player counts:
 *   eight players as `[4,2,2]` is 420 fillings before splits.
 */
function forEachExactArrangement(
  playing: PlayerId[],
  sizes: number[],
  visit: (groups: Group[]) => void
): void {
  const groups: Group[] = [];
  const uniform = sizes.every((s) => s === sizes[0]);

  const chooseSubset = (
    pool: PlayerId[],
    count: number,
    fixFirst: boolean,
    onChosen: (chosen: PlayerId[], rest: PlayerId[]) => void
  ): void => {
    if (fixFirst) {
      const [head, ...rest] = pool;
      const combo: number[] = [];
      const pick = (start: number): void => {
        if (combo.length === count - 1) {
          const comboSet = new Set(combo);
          onChosen(
            [head, ...combo.map((i) => rest[i])],
            rest.filter((_, i) => !comboSet.has(i))
          );
          return;
        }
        for (let i = start; i < rest.length; i++) {
          combo.push(i);
          pick(i + 1);
          combo.pop();
        }
      };
      pick(0);
      return;
    }

    const combo: number[] = [];
    const pick = (start: number): void => {
      if (combo.length === count) {
        const comboSet = new Set(combo);
        onChosen(
          combo.map((i) => pool[i]),
          pool.filter((_, i) => !comboSet.has(i))
        );
        return;
      }
      for (let i = start; i < pool.length; i++) {
        combo.push(i);
        pick(i + 1);
        combo.pop();
      }
    };
    pick(0);
  };

  const fill = (remaining: PlayerId[], position: number): void => {
    if (position === sizes.length) {
      visit(groups);
      return;
    }
    chooseSubset(remaining, sizes[position], uniform, (chosen, rest) => {
      groups.push(chosen);
      fill(rest, position + 1);
      groups.pop();
    });
  };

  fill(playing, 0);
}

/**
 * Thrown when the engine is handed input it cannot mean anything sensible
 * about — a duplicated player, a negative game count, a fractional court.
 *
 * The engine used to absorb these silently. A roster with the same id twice
 * produces fewer distinct players than it appears to, so `usableCourts` can
 * fall to zero and the caller reports "not enough players" — which is a lie
 * that sends the host looking for absent players instead of at the corrupt
 * state that actually caused it. Failing loudly is worth more than a plausible
 * wrong answer, because the plausible wrong answer is unfalsifiable at
 * courtside.
 */
export class InvalidRoundInputError extends Error {
  readonly code = 'INVALID_ROUND_INPUT';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidRoundInputError';
  }
}

function assertCountMap(map: Map<string, number>, label: string, integer: boolean): void {
  for (const [key, value] of map) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new InvalidRoundInputError(`${label} for "${key}" must be a non-negative finite number`);
    }
    if (integer && !Number.isInteger(value)) {
      throw new InvalidRoundInputError(`${label} for "${key}" must be a whole number`);
    }
  }
}

function assertRatingsMap(map: Map<PlayerId, number>): void {
  for (const [id, rating] of map) {
    if (typeof rating !== 'number' || !Number.isFinite(rating)) {
      throw new InvalidRoundInputError(`rating for "${id}" must be a finite number`);
    }
  }
}

/**
 * Checked before any work, so a bad input can never half-produce a round.
 * Deliberately does not check that history keys exist in the roster: history
 * is all-time and spans players who are not here tonight, which is normal.
 */
export function validateRoundInput(
  roster: PlayerId[],
  courtCount: number | CourtSize[],
  history: MatchHistory,
  avoidSplit?: { teamA: Team; teamB: Team },
  ratings?: RatingsInput
): void {
  if (Array.isArray(courtCount)) {
    for (const size of courtCount) {
      if (size !== 2 && size !== 4) {
        throw new InvalidRoundInputError(`court size must be 2 or 4, got ${size}`);
      }
    }
  } else if (!Number.isInteger(courtCount) || courtCount < 0) {
    throw new InvalidRoundInputError(`courtCount must be a non-negative whole number, got ${courtCount}`);
  }

  const seen = new Set<PlayerId>();
  for (const id of roster) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new InvalidRoundInputError('roster contains an empty or non-string player id');
    }
    if (seen.has(id)) {
      throw new InvalidRoundInputError(`roster contains "${id}" more than once`);
    }
    seen.add(id);
  }

  assertCountMap(history.gamesPlayedThisSession, 'gamesPlayedThisSession', true);
  assertCountMap(history.partnerCounts, 'partnerCounts', true);
  assertCountMap(history.opponentCounts, 'opponentCounts', true);
  if (history.waitingSince) {
    assertCountMap(history.waitingSince, 'waitingSince', false);
  }

  if (ratings) {
    if (ratings instanceof Map) {
      assertRatingsMap(ratings);
    } else {
      assertRatingsMap(ratings.singles);
      assertRatingsMap(ratings.doubles);
    }
  }

  if (avoidSplit) {
    const size = avoidSplit.teamA.length;
    if (size !== avoidSplit.teamB.length || (size !== 1 && size !== 2)) {
      throw new InvalidRoundInputError('avoidSplit teams must be the same size, one or two players each');
    }
    const players = [...avoidSplit.teamA, ...avoidSplit.teamB];
    const expected = size * 2;
    if (players.length !== expected || new Set(players).size !== expected) {
      throw new InvalidRoundInputError(
        size === 1 ? 'avoidSplit must name two distinct players' : 'avoidSplit must name four distinct players'
      );
    }
  }
}

export function generateRound(
  roster: PlayerId[],
  courtCount: number | CourtSize[],
  history: MatchHistory,
  random: () => number = Math.random,
  avoidSplit?: { teamA: Team; teamB: Team },
  /** Supplied only in balanced mode; omitted, behaviour is unchanged. */
  ratings?: RatingsInput,
  /** A player's skill level. Omitted, or `band` false, behaviour is unchanged. */
  levels?: ReadonlyMap<PlayerId, Level | null>,
  /** The ±1 level band (D4, soft-dominant). Off by default. */
  band = false
): RoundResult {
  validateRoundInput(roster, courtCount, history, avoidSplit, ratings);

  // A singles court's only "split" is the two players facing each other, so a
  // hard exclusion on it would leave no legal split at all — directly
  // contradicting the guarantee below that a legal alternative always
  // remains. Route a singles avoidSplit through the soft groupRepeat signal
  // instead: it steers away from immediately reforming that exact pair
  // without ever making the round unsolvable. A doubles avoidSplit keeps the
  // original hard exclusion, applied only to court 0 — the one a reshuffle
  // commits — regardless of how many courts are being planned.
  //
  // Computed before `selectSittingOut` runs, not after: with exactly two
  // players free for a singles court, who is chosen to play *is* the match —
  // there is no split-scoring step left to steer away from it once selection
  // has already picked that pair. Folding the avoided pair into the same
  // recentGroupKeys set selectSittingOut already consults (its single-court
  // boundary-swap escape) is what lets it choose differently up front.
  const avoidKeys =
    avoidSplit && avoidSplit.teamA.length === 2
      ? new Set([
          pairKey(avoidSplit.teamA[0], avoidSplit.teamA[1]),
          pairKey(avoidSplit.teamB[0], avoidSplit.teamB[1]),
        ])
      : null;

  const recentGroupKeys =
    avoidSplit && avoidSplit.teamA.length === 1
      ? new Set([...(history.recentGroupKeys ?? []), groupKey([...avoidSplit.teamA, ...avoidSplit.teamB])])
      : history.recentGroupKeys ?? null;

  const { playing, sittingOut } = selectSittingOut(
    roster,
    courtCount,
    history.gamesPlayedThisSession,
    random,
    history.waitingSince,
    recentGroupKeys,
    levels,
    band
  );

  const sizes = normalizeSizes(courtCount);
  const offered = consumedSizes(sizes, playing.length);

  if (offered.length === 0) {
    return { courts: [], sittingOut };
  }

  const floors = historyFloors(playing, history.partnerCounts, history.opponentCounts);
  const ctx: SearchContext = {
    partnerCounts: history.partnerCounts,
    opponentCounts: history.opponentCounts,
    ratings,
    floors,
    avoidKeys,
    recentGroupKeys,
    levels: band ? levels : undefined,
  };

  const better = (candidate: CourtAssignment[], incumbent: CourtAssignment[] | null): boolean =>
    !incumbent ||
    compareArrangements(
      candidate,
      incumbent,
      history.partnerCounts,
      history.opponentCounts,
      ratings,
      floors,
      recentGroupKeys,
      ctx.levels
    ) < 0;

  let best: CourtAssignment[] | null = null;
  const uniform = offered.every((s) => s === offered[0]);

  if (playing.length <= EXACT_ENUMERATION_MAX_PLAYING) {
    // Shuffled so that equally-scoring arrangements — an untouched history
    // makes every arrangement equal — are still picked at random rather than
    // by roster order.
    forEachExactArrangement(shuffle(playing, random), offered, (groups) => {
      if (uniform) {
        // Every position has the same size, so a full rotation is valid and
        // gives every group in the partition a turn at position 0 — the only
        // position `avoidKeys` can ever constrain. This branch is byte-for-
        // byte identical to the engine's original (all-doubles) behaviour.
        for (let lead = 0; lead < groups.length; lead++) {
          const ordered = [...groups.slice(lead), ...groups.slice(0, lead)];
          const candidate = bestArrangementForGroups(ordered, ctx);
          if (candidate && better(candidate, best)) best = candidate;
        }
      } else {
        // Sizes differ, so an arbitrary rotation would hand a group of the
        // wrong size to a position that requires another — only a same-size
        // group can ever legally sit at position 0. Swapping position 0 with
        // each same-size position gives every eligible group its turn there
        // without disturbing any other position's required size. The score
        // does not depend on how positions other than 0 are ordered among
        // themselves, so this is exactly as thorough as a full rotation
        // would be, just restricted to moves that stay legal.
        for (let j = 0; j < groups.length; j++) {
          if (offered[j] !== offered[0]) continue;
          const ordered = [...groups];
          if (j !== 0) [ordered[0], ordered[j]] = [ordered[j], ordered[0]];
          const candidate = bestArrangementForGroups(ordered, ctx);
          if (candidate && better(candidate, best)) best = candidate;
        }
      }
    });
  } else {
    let sinceImprovement = 0;
    for (let restart = 0; restart < SEARCH_RESTARTS; restart++) {
      const seed = bestArrangementForGroups(
        buildRandomArrangement(playing, offered, random).map(groupOf),
        ctx
      );
      if (!seed) continue;
      const improved = improveArrangement(seed, ctx);
      if (better(improved, best)) {
        best = improved;
        sinceImprovement = 0;
      } else if (++sinceImprovement >= SEARCH_RESTART_PATIENCE) {
        break;
      }
    }
  }

  // `best` is null only when every legal split of some court scored NaN — a
  // corrupt count somewhere upstream. Reporting no courts hands that to the
  // caller's existing "not enough players" path rather than letting a null
  // through to be read as an array. The old fallback for "every candidate
  // reproduced the avoided split" is gone because it can no longer happen:
  // the exclusion now removes one split of one court, never a whole candidate,
  // so a legal alternative always remains.
  return { courts: best ?? [], sittingOut };
}

/** One seat on a court being manually assembled: a player id, or empty. */
export type Seat = PlayerId | null;

/** A court with zero or more of its seats still unfilled. Both teams are
 *  always the same length — the court's format — exactly like `Team[]`. */
export interface SeatedCourt {
  teamA: Seat[];
  teamB: Seat[];
}

function assertSeatedCourtShape(seats: SeatedCourt): void {
  const { teamA, teamB } = seats;
  if (teamA.length !== teamB.length || (teamA.length !== 1 && teamA.length !== 2)) {
    throw new InvalidRoundInputError(
      `court teams must be the same size, one or two seats each: got ${teamA.length} and ${teamB.length}`
    );
  }
  const seen = new Set<PlayerId>();
  for (const seat of [...teamA, ...teamB]) {
    if (seat === null) continue;
    if (seen.has(seat)) {
      throw new InvalidRoundInputError(`court seats name "${seat}" more than once`);
    }
    seen.add(seat);
  }
}

function assertPool(pool: PlayerId[], seated: Set<PlayerId>): void {
  const seen = new Set<PlayerId>();
  for (const id of pool) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new InvalidRoundInputError('pool contains an empty or non-string player id');
    }
    if (seen.has(id)) {
      throw new InvalidRoundInputError(`pool contains "${id}" more than once`);
    }
    if (seated.has(id)) {
      throw new InvalidRoundInputError(`pool contains "${id}", who is already seated on this court`);
    }
    seen.add(id);
  }
}

/**
 * Fills the empty seats of one partly (or fully) seated court, leaving every
 * already-seated player exactly where the host put them — position included.
 * The court a host is filling by hand in custom mode; not a replacement for
 * `generateRound`, which plans a whole round across every idle court.
 *
 * Deliberately does not call into `generateRound`'s search machinery
 * (`selectSittingOut`, `buildRandomArrangement`, `improveArrangement`,
 * `forEachExactArrangement`): every one of those exists to move players
 * between courts or decide who sits out, and this function must do neither —
 * it only ever touches the seats it was asked to fill, on the one court it
 * was asked to fill them on. Not editing that code path is also what keeps
 * `generateRound`'s own behaviour (and its golden tests) byte-identical.
 *
 * Two decisions, kept separate on purpose:
 *
 * - **Rotation decides *who*.** The pool is ordered by games played this
 *   session (fewest first), then by longest wait — the same priority
 *   `selectSittingOut` and the on-screen waiting list already use. The
 *   players actually offered a seat are the top `empties.length` of that
 *   order, widened to include anyone else exactly tied with the last one on
 *   both games and wait — the same boundary a real tie would produce, so the
 *   objective below only ever gets to choose among players rotation
 *   genuinely cannot separate.
 * - **The objective decides *seating*.** Among the (usually very small)
 *   space of ways to seat the offered players into the empty seats, the one
 *   already-seated players are never moved from — pick whichever scores best
 *   by the same comparison `generateRound` uses, via the shared
 *   `compareArrangements`/`arrangementScoreComponents`. No ratings are ever
 *   passed here (see the module-level note by the call sites): the host is
 *   placing people by hand, and a hidden rating term would silently pull
 *   against the seats they just chose.
 *
 * Returns `null` when the pool cannot fill every empty seat — the caller
 * reports that as "not enough players," exactly as `generateRound` does.
 */
export function completeCourt(
  seats: SeatedCourt,
  pool: PlayerId[],
  history: MatchHistory,
  random: () => number = Math.random
): { teamA: PlayerId[]; teamB: PlayerId[] } | null {
  assertSeatedCourtShape(seats);
  const seatedIds = new Set<PlayerId>(
    [...seats.teamA, ...seats.teamB].filter((s): s is PlayerId => s !== null)
  );
  assertPool(pool, seatedIds);
  assertCountMap(history.gamesPlayedThisSession, 'gamesPlayedThisSession', true);
  assertCountMap(history.partnerCounts, 'partnerCounts', true);
  assertCountMap(history.opponentCounts, 'opponentCounts', true);
  if (history.waitingSince) {
    assertCountMap(history.waitingSince, 'waitingSince', false);
  }

  const empties: { team: 'A' | 'B'; index: number }[] = [];
  seats.teamA.forEach((seat, index) => {
    if (seat === null) empties.push({ team: 'A', index });
  });
  seats.teamB.forEach((seat, index) => {
    if (seat === null) empties.push({ team: 'B', index });
  });

  if (empties.length === 0) {
    return {
      teamA: seats.teamA as PlayerId[],
      teamB: seats.teamB as PlayerId[],
    };
  }

  if (pool.length < empties.length) return null;

  const priorityKey = (id: PlayerId): [number, number] => [
    history.gamesPlayedThisSession.get(id) ?? 0,
    history.waitingSince?.get(id) ?? 0,
  ];

  const ordered = shuffle(pool, random).sort((a, b) => {
    const [aGames, aWait] = priorityKey(a);
    const [bGames, bWait] = priorityKey(b);
    return aGames - bGames || aWait - bWait;
  });

  const k = empties.length;
  const boundaryKey = priorityKey(ordered[k - 1]).join('|');
  const candidates = [
    ...ordered.slice(0, k),
    ...ordered.slice(k).filter((id) => priorityKey(id).join('|') === boundaryKey),
  ];

  const floors = historyFloors(
    [...seatedIds, ...candidates],
    history.partnerCounts,
    history.opponentCounts
  );

  const fillWith = (chosen: PlayerId[]): { teamA: Team; teamB: Team } => {
    const teamA = [...seats.teamA];
    const teamB = [...seats.teamB];
    empties.forEach((seat, i) => {
      (seat.team === 'A' ? teamA : teamB)[seat.index] = chosen[i];
    });
    return { teamA: teamA as Team, teamB: teamB as Team };
  };

  let best: { teamA: Team; teamB: Team } | null = null;
  const used = new Array<boolean>(candidates.length).fill(false);
  const chosen: PlayerId[] = [];

  const search = (): void => {
    if (chosen.length === k) {
      const candidate = fillWith(chosen);
      if (
        !best ||
        compareArrangements(
          [candidate],
          [best],
          history.partnerCounts,
          history.opponentCounts,
          undefined,
          floors,
          history.recentGroupKeys ?? null
        ) < 0
      ) {
        best = candidate;
      }
      return;
    }
    for (let i = 0; i < candidates.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      chosen.push(candidates[i]);
      search();
      chosen.pop();
      used[i] = false;
    }
  };
  search();

  return best;
}
