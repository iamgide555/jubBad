/**
 * Pure harness measuring whether the real pairing engine delivers more
 * partner variety over a season than two naive baselines. No schema change,
 * no server dependency — see docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md,
 * section C14.
 */

import { generateRound, pairKey, selectSittingOut, shuffle, type MatchHistory, type PlayerId } from './pairing.ts';

export function makeSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export interface SimScenario {
  playerCount: number;
  minAttend: number;
  maxAttend: number;
  courts: number;
  matchesPerCourt: number;
  nights: number;
  minDurationMin: number;
  maxDurationMin: number;
}

export const DEFAULT_SCENARIO: SimScenario = {
  playerCount: 16,
  minAttend: 12,
  maxAttend: 14,
  courts: 3,
  matchesPerCourt: 8,
  nights: 12,
  minDurationMin: 12,
  maxDurationMin: 18,
};

export function playerIdsFor(scenario: SimScenario): PlayerId[] {
  return Array.from({ length: scenario.playerCount }, (_, i) => `p${i}`);
}

export function generateAttendance(scenario: SimScenario, random: () => number): PlayerId[][] {
  const players = playerIdsFor(scenario);
  const span = scenario.maxAttend - scenario.minAttend;
  const nights: PlayerId[][] = [];
  for (let n = 0; n < scenario.nights; n++) {
    const count = scenario.minAttend + Math.min(span, Math.floor(random() * (span + 1)));
    nights.push(shuffle(players, random).slice(0, count));
  }
  return nights;
}

export function coAttendanceCounts(attendance: PlayerId[][]): Map<string, number> {
  const co = new Map<string, number>();
  for (const night of attendance) {
    for (let i = 0; i < night.length; i++) {
      for (let j = i + 1; j < night.length; j++) {
        const key = pairKey(night[i], night[j]);
        co.set(key, (co.get(key) ?? 0) + 1);
      }
    }
  }
  return co;
}

type Four = [PlayerId, PlayerId, PlayerId, PlayerId];
export type Split = { teamA: [PlayerId, PlayerId]; teamB: [PlayerId, PlayerId] };

/** The three ways to split four players into two teams of two — same table
 *  `pairing-quality.test.ts` uses for its own exhaustive checks. */
const SPLIT_PATTERNS: [number, number, number, number][] = [
  [0, 1, 2, 3],
  [0, 2, 1, 3],
  [0, 3, 1, 2],
];

function splitFromPattern(four: Four, pattern: [number, number, number, number]): Split {
  const [a, b, c, d] = pattern;
  return { teamA: [four[a], four[b]], teamB: [four[c], four[d]] };
}

export function pickRandomSplit(four: Four, random: () => number): Split {
  const pattern = SPLIT_PATTERNS[Math.min(2, Math.floor(random() * 3))];
  return splitFromPattern(four, pattern);
}

/** The baseline PaQueueKa and Doubles Team Maker advertise: never reunite a
 *  player with the partner from their immediately preceding match, unless
 *  every split would. */
export function pickNoBackToBackSplit(
  four: Four,
  lastPartner: Map<PlayerId, PlayerId>,
  random: () => number
): Split {
  const clean = SPLIT_PATTERNS.filter((pattern) => {
    const { teamA, teamB } = splitFromPattern(four, pattern);
    return lastPartner.get(teamA[0]) !== teamA[1] && lastPartner.get(teamB[0]) !== teamB[1];
  });
  const pool = clean.length > 0 ? clean : SPLIT_PATTERNS;
  const pattern = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
  return splitFromPattern(four, pattern);
}

export type PickerName = 'engine' | 'random' | 'no-back-to-back';

/**
 * Fills `courtsNeeded` currently-idle courts from `available` players. The
 * engine plans all of them jointly via the real `generateRound` — exactly
 * what `SessionsService.proposeExclusively` does when more than one court is
 * idle at once. The baselines only use `selectSittingOut` for *who* plays
 * (rotation fairness); they have no notion of planning multiple courts
 * jointly, so the chosen players are shuffled and chopped into groups of
 * four, and each group's split is decided independently.
 */
export function fillAllIdleCourts(
  available: PlayerId[],
  courtsNeeded: number,
  picker: PickerName,
  history: MatchHistory,
  lastPartner: Map<PlayerId, PlayerId>,
  random: () => number
): { courts: Split[] } {
  if (picker === 'engine') {
    const { courts } = generateRound(available, courtsNeeded, history, random);
    return {
      courts: courts.map((c) => ({
        teamA: c.teamA as [PlayerId, PlayerId],
        teamB: c.teamB as [PlayerId, PlayerId],
      })),
    };
  }

  const { playing } = selectSittingOut(
    available,
    courtsNeeded,
    history.gamesPlayedThisSession,
    random,
    history.waitingSince
  );
  const shuffled = shuffle(playing, random);
  const courts: Split[] = [];
  for (let i = 0; i < courtsNeeded; i++) {
    const four = shuffled.slice(i * 4, i * 4 + 4) as Four;
    courts.push(
      picker === 'random' ? pickRandomSplit(four, random) : pickNoBackToBackSplit(four, lastPartner, random)
    );
  }
  return { courts };
}

/**
 * Simulates one night as a discrete-event queue: all 3 courts start together
 * (the one moment they're genuinely idle at once — mirrors a real session's
 * opening fill), then whichever court finishes next is refilled on its own
 * from whoever isn't currently on another court, exactly the shape
 * `SessionsService.proposeExclusively` uses in production. A court retires
 * once it reaches `matchesPerCourt` for the night; its players simply become
 * part of the available pool for whichever court asks next.
 */
function runNight(
  scenario: SimScenario,
  nightAttendees: PlayerId[],
  picker: PickerName,
  partnerCounts: Map<string, number>,
  opponentCounts: Map<string, number>,
  lastPartner: Map<PlayerId, PlayerId>,
  random: () => number
): void {
  const gamesPlayedThisSession = new Map<PlayerId, number>();
  const waitingSince = new Map<PlayerId, number>();
  for (const id of nightAttendees) waitingSince.set(id, 0);
  const history: MatchHistory = { partnerCounts, opponentCounts, gamesPlayedThisSession, waitingSince };

  const duration = () =>
    scenario.minDurationMin + random() * (scenario.maxDurationMin - scenario.minDurationMin);

  const recordMatch = (teamA: [PlayerId, PlayerId], teamB: [PlayerId, PlayerId], at: number): void => {
    const bump = (map: Map<string, number>, a: PlayerId, b: PlayerId) =>
      map.set(pairKey(a, b), (map.get(pairKey(a, b)) ?? 0) + 1);
    bump(partnerCounts, teamA[0], teamA[1]);
    bump(partnerCounts, teamB[0], teamB[1]);
    for (const a of teamA) for (const b of teamB) bump(opponentCounts, a, b);
    lastPartner.set(teamA[0], teamA[1]);
    lastPartner.set(teamA[1], teamA[0]);
    lastPartner.set(teamB[0], teamB[1]);
    lastPartner.set(teamB[1], teamB[0]);
    for (const p of [...teamA, ...teamB]) {
      gamesPlayedThisSession.set(p, (gamesPlayedThisSession.get(p) ?? 0) + 1);
      waitingSince.set(p, at);
    }
  };

  const busy = new Set<PlayerId>();
  const courtMatches = new Array<number>(scenario.courts).fill(0);
  const events: { court: number; freeAt: number; teamA: [PlayerId, PlayerId]; teamB: [PlayerId, PlayerId] }[] = [];
  const available = () => nightAttendees.filter((id) => !busy.has(id));

  const { courts: startingCourts } = fillAllIdleCourts(
    available(),
    scenario.courts,
    picker,
    history,
    lastPartner,
    random
  );
  startingCourts.forEach((match, court) => {
    for (const p of [...match.teamA, ...match.teamB]) busy.add(p);
    events.push({ court, freeAt: duration(), teamA: match.teamA, teamB: match.teamB });
  });

  while (events.length > 0) {
    events.sort((a, b) => a.freeAt - b.freeAt);
    const event = events.shift()!;
    for (const p of [...event.teamA, ...event.teamB]) busy.delete(p);
    recordMatch(event.teamA, event.teamB, event.freeAt);
    courtMatches[event.court] += 1;
    if (courtMatches[event.court] < scenario.matchesPerCourt) {
      const { courts } = fillAllIdleCourts(available(), 1, picker, history, lastPartner, random);
      const match = courts[0];
      for (const p of [...match.teamA, ...match.teamB]) busy.add(p);
      events.push({ court: event.court, freeAt: event.freeAt + duration(), teamA: match.teamA, teamB: match.teamB });
    }
  }
}

/** Runs `scenario.nights` nights back to back, carrying partner/opponent
 *  history across nights exactly as the real server does (it is never reset
 *  between sessions). Returns a cumulative `partnerCounts` snapshot after
 *  each night. */
export function simulateNights(
  scenario: SimScenario,
  attendance: PlayerId[][],
  picker: PickerName,
  random: () => number
): Map<string, number>[] {
  const partnerCounts = new Map<string, number>();
  const opponentCounts = new Map<string, number>();
  const lastPartner = new Map<PlayerId, PlayerId>();
  const snapshots: Map<string, number>[] = [];
  for (const nightAttendees of attendance) {
    runNight(scenario, nightAttendees, picker, partnerCounts, opponentCounts, lastPartner, random);
    snapshots.push(new Map(partnerCounts));
  }
  return snapshots;
}
