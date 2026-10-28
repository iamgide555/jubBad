/**
 * Elo replay: prediction quality by K for one group.
 *
 * Replays a group's decisive doubles matches in confirmed order and scores each
 * match with the rating from before it (Brier, log-loss, accuracy, calibration),
 * for constant K and the per-player variant. Seeds are the stored level seeds,
 * applied the way engines/elo.ts applies a RatingAnchor.
 *
 * Usage:
 *   node --experimental-strip-types --no-warnings engines/evidence/elo-replay.mts <db> <groupCode>
 *
 * <db> is a copy of a production backup (see engines/evidence/README.md).
 * Read-only; never commit the database or this script's output.
 */
import { DatabaseSync } from 'node:sqlite';
import { STARTING_RATING } from '../elo.ts';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const G = process.argv[3];
const players = db.prepare('select id,name,level,levelSeed,levelSetAt from Player where groupId=?').all(G) as any[];
const name = new Map(players.map((p) => [p.id, p.name]));
const anchors = new Map(players.map((p) => [p.id, { rating: p.levelSeed ?? 1200, setAt: p.levelSetAt ? Date.parse(p.levelSetAt) : null }]));
const rows = db.prepare(`select p.teamA,p.teamB,p.winner,p.confirmedAt from Pairing p join Session s on s.code=p.sessionId where s.groupId=? and p.confirmedAt is not null and p.endedAt is not null order by p.confirmedAt`).all(G) as any[];
const all = rows.map((r) => ({ teamA: JSON.parse(r.teamA), teamB: JSON.parse(r.teamB), winner: r.winner, at: Date.parse(r.confirmedAt) }));
const dec = all.filter((m) => m.winner === 'A' || m.winner === 'B');
console.log('confirmed', all.length, 'decisive', dec.length, 'singles', dec.filter((m) => m.teamA.length === 1).length);
console.log('levels set:', players.filter((p) => p.level).length, '/', players.length);

const doubles = dec.filter((m) => m.teamA.length === 2);
// online prediction with a given K (replicates computeRatings but param K + anchors) 
function replay(K: number, perPlayer = false) {
  const r = new Map<string, number>(); const applied = new Set<string>(); const n = new Map<string, number>();
  const get = (id: string) => r.get(id) ?? anchors.get(id)?.rating ?? STARTING_RATING;
  let brier = 0, ll = 0, hit = 0, base = 0; const buckets: any[] = []; const log: any[] = [];
  for (const m of doubles) {
    for (const id of [...m.teamA, ...m.teamB]) {
      const a = anchors.get(id);
      if (a && a.setAt !== null && m.at >= a.setAt && !applied.has(id)) { r.set(id, a.rating); applied.add(id); }
    }
    const ra = m.teamA.reduce((s: number, i: string) => s + get(i), 0) / 2;
    const rb = m.teamB.reduce((s: number, i: string) => s + get(i), 0) / 2;
    const e = 1 / (1 + 10 ** ((rb - ra) / 400));
    const y = m.winner === 'A' ? 1 : 0;
    brier += (y - e) ** 2; base += (y - 0.5) ** 2;
    ll += -(y * Math.log(Math.max(e, 1e-9)) + (1 - y) * Math.log(Math.max(1 - e, 1e-9)));
    if (e !== 0.5) hit += (e > 0.5) === (y === 1) ? 1 : 0;
    log.push({ e, y, spreadA: Math.abs(get(m.teamA[0]) - get(m.teamA[1])), spreadB: Math.abs(get(m.teamB[0]) - get(m.teamB[1])), gap: Math.abs(ra - rb), m });
    if (!perPlayer) {
      const d = K * (y - e);
      for (const i of m.teamA) { r.set(i, get(i) + d); n.set(i, (n.get(i) ?? 0) + 1); }
      for (const i of m.teamB) { r.set(i, get(i) - d); n.set(i, (n.get(i) ?? 0) + 1); }
    } else {
      // each player vs opposing average, own rating vs opp avg
      for (const i of m.teamA) { const ei = 1 / (1 + 10 ** ((rb - get(i)) / 400)); r.set(i, get(i) + K * (y - ei)); }
      for (const i of m.teamB) { const ei = 1 / (1 + 10 ** ((ra - get(i)) / 400)); r.set(i, get(i) + K * ((1 - y) - ei)); }
    }
  }
  const N = doubles.length;
  return { K, perPlayer, brier: brier / N, baseline: base / N, logloss: ll / N, acc: hit / N, ratings: r, log };
}
console.log('\n== doubles prediction quality (lower brier better; baseline=coin flip 0.25) ==');
for (const K of [8, 16, 24, 32, 48]) { const x = replay(K); console.log(`K=${K}`.padEnd(8), 'brier', x.brier.toFixed(4), 'logloss', x.logloss.toFixed(4), 'acc', (x.acc * 100).toFixed(1) + '%'); }
for (const K of [16, 32]) { const x = replay(K, true); console.log(`pp K=${K}`.padEnd(8), 'brier', x.brier.toFixed(4), 'logloss', x.logloss.toFixed(4), 'acc', (x.acc * 100).toFixed(1) + '%'); }

const cur = replay(16);
console.log('\n== final doubles ratings (K=16) ==');
const stat = new Map<string, { g: number; w: number }>();
for (const m of doubles) for (const [side, t] of [['A', m.teamA], ['B', m.teamB]] as const) for (const i of t) { const s = stat.get(i) ?? { g: 0, w: 0 }; s.g++; if (m.winner === side) s.w++; stat.set(i, s); }
const lvl = new Map(players.map((p) => [p.id, p.level ?? '-']));
const tbl = [...stat].map(([i, s]) => ({ name: name.get(i), lvl: lvl.get(i), seed: anchors.get(i)!.rating, g: s.g, win: (100 * s.w / s.g).toFixed(0) + '%', rating: Math.round(cur.ratings.get(i) ?? 1200) })).sort((a, b) => b.rating - a.rating);
console.table(tbl);

console.log('== calibration (predicted P for favoured side vs actual) ==');
const bk = [[0.5, 0.55], [0.55, 0.6], [0.6, 0.7], [0.7, 1.01]];
for (const [lo, hi] of bk) {
  const sel = cur.log.filter((x: any) => { const f = Math.max(x.e, 1 - x.e); return f >= lo && f < hi && x.e !== 0.5; });
  const wins = sel.filter((x: any) => (x.e > 0.5) === (x.y === 1)).length;
  const avgP = sel.reduce((s: number, x: any) => s + Math.max(x.e, 1 - x.e), 0) / (sel.length || 1);
  console.log(`fav ${lo}-${Math.min(hi, 1)}: n=${sel.length} predicted ${(avgP * 100).toFixed(0)}% actual ${(100 * wins / (sel.length || 1)).toFixed(0)}%`);
}
const exact = cur.log.filter((x: any) => x.e === 0.5).length;
console.log('exactly 50/50 matches (no info):', exact, '/', cur.log.length);
const mixed = cur.log.filter((x: any) => Math.max(x.spreadA, x.spreadB) >= 200);
console.log('matches with a team spread >=200 (carry situation):', mixed.length, '/', cur.log.length);
const gaps = cur.log.map((x: any) => x.gap).sort((a: number, b: number) => a - b);
console.log('team-gap median/p90/max:', gaps[gaps.length >> 1].toFixed(0), gaps[Math.floor(gaps.length * 0.9)].toFixed(0), gaps.at(-1).toFixed(0));
