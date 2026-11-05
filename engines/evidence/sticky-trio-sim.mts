/**
 * Sticky-group sim behind the one-swap variety step (2026-11-06 finding in
 * docs/2026-09-25-engine-evidence-gaps.md). Plays whole nights on two courts
 * that rotate independently, through the real `generateRound` and the real
 * rest guard (`playersNeedingRest`), in สลับคู่ (games-queued) mode.
 *
 * Reports, averaged over nights: the worst opponent repeat, pairs who faced
 * each other 4+ times, players per game straight off court, the longest run
 * of back-to-back games, the longest wait, and the games-played spread.
 * The pre-change baseline lives in the evidence-gaps doc (this engine no
 * longer has a no-swap switch to compare against in-process).
 *
 * Usage (repo root):
 *   node --experimental-strip-types --no-warnings engines/evidence/sticky-trio-sim.mts [nights=40] [games=26]
 */
import { generateRound, pairKey, type MatchHistory } from '../pairing.ts';
import { playersNeedingRest, type PlayedGame } from '../rest.ts';

const NIGHTS = Number(process.argv[2] ?? 40);
const GAMES = Number(process.argv[3] ?? 26);

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

function night(players: number, seed: number) {
  const random = seeded(seed);
  const ids = Array.from({ length: players }, (_, i) => `p${i}`);
  const games = new Map(ids.map((p) => [p, 0]));
  const since = new Map(ids.map((p) => [p, 0]));
  const partner = new Map<string, number>();
  const opponent = new Map<string, number>();
  const played: PlayedGame[] = [];
  const busyUntil: (number | null)[] = [null, null];
  const onCourt: string[][] = [[], []];
  const streak = new Map<string, number>();
  let t = 0;
  let count = 0;
  let straightOff = 0;
  let longestRun = 0;
  let longestWait = 0;

  while (count < GAMES) {
    for (let court = 0; court < 2 && count < GAMES; court++) {
      if (busyUntil[court] !== null && busyUntil[court]! > t) continue;
      if (busyUntil[court] !== null) {
        for (const p of onCourt[court]) since.set(p, t);
        played.find((g) => g.endedAt === null && g.players.every((p) => onCourt[court].includes(p)))!.endedAt = t;
        busyUntil[court] = null;
        onCourt[court] = [];
      }
      const busy = new Set(onCourt.flat());
      const free = ids.filter((p) => !busy.has(p));
      if (free.length < 4) continue;

      const history: MatchHistory = {
        partnerCounts: partner,
        opponentCounts: opponent,
        gamesPlayedThisSession: games,
        waitingSince: since,
        needsRest: playersNeedingRest(played),
      };
      const { teamA, teamB } = generateRound(free, 1, history, random).courts[0];
      const four = [...teamA, ...teamB];

      bump(partner, pairKey(teamA[0], teamA[1]));
      bump(partner, pairKey(teamB[0], teamB[1]));
      for (const a of teamA) for (const b of teamB) bump(opponent, pairKey(a, b));
      for (const p of four) {
        const back = since.get(p) === t && games.get(p)! > 0;
        if (back) straightOff++;
        streak.set(p, back ? (streak.get(p) ?? 0) + 1 : 0);
        longestRun = Math.max(longestRun, streak.get(p)!);
        longestWait = Math.max(longestWait, t - since.get(p)!);
        games.set(p, games.get(p)! + 1);
      }
      // Started a hair after this tick's ends, so "nothing started between" is exact.
      played.push({ players: four, confirmedAt: t + 0.001 * (count + 1), endedAt: null });
      onCourt[court] = four;
      busyUntil[court] = t + 6 + Math.floor(random() * 5);
      count++;
    }
    t++;
  }

  const opp = [...opponent.values()];
  const g = [...games.values()];
  return {
    worstOpponentRepeat: Math.max(...opp),
    pairsOpposed4Plus: opp.filter((v) => v >= 4).length,
    straightOffPerGame: straightOff / GAMES,
    longestBackToBackRun: longestRun,
    longestWaitMin: longestWait,
    gamesSpread: Math.max(...g) - Math.min(...g),
  };
}

for (const players of [10, 11, 12]) {
  const totals: Record<string, number> = {};
  for (let seed = 1; seed <= NIGHTS; seed++) {
    for (const [k, v] of Object.entries(night(players, seed))) totals[k] = (totals[k] ?? 0) + v / NIGHTS;
  }
  console.log(
    `${players} players: ` +
      Object.entries(totals)
        .map(([k, v]) => `${k}=${v.toFixed(2)}`)
        .join(' ')
  );
}
