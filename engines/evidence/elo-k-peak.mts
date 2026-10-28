/**
 * Elo K peak: how large K can go, rating swing per match, rank stability.
 *
 * Extends elo-k-sweep to K up to 512 and reports average rating move per match,
 * rating range, and how little the final player ordering changes with K.
 *
 * Usage:
 *   node --experimental-strip-types --no-warnings engines/evidence/elo-k-peak.mts <db> <groupA> <groupB>
 *
 * <db> is a copy of a production backup (see engines/evidence/README.md).
 * Read-only; never commit the database or this script's output.
 */
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
function load(G: string) {
  const players = db.prepare('select id,levelSeed,levelSetAt from Player where groupId=?').all(G) as any[];
  const anchors = new Map(players.map((p) => [p.id, { rating: p.levelSeed ?? 1200, setAt: p.levelSetAt ? Date.parse(p.levelSetAt) : null }]));
  const rows = db.prepare(`select p.teamA,p.teamB,p.winner,p.confirmedAt from Pairing p join Session s on s.code=p.sessionId where s.groupId=? and p.confirmedAt is not null and p.endedAt is not null order by p.confirmedAt`).all(G) as any[];
  return { anchors, m: rows.map((r) => ({ a: JSON.parse(r.teamA), b: JSON.parse(r.teamB), w: r.winner, at: Date.parse(r.confirmedAt) })).filter((x) => (x.w === 'A' || x.w === 'B') && x.a.length === 2) };
}
const G = { A: load(process.argv[3]), B: load(process.argv[4]) };
function run(g: any, K: number, S = 400) {
  const r = new Map<string, number>(), ap = new Set<string>();
  const get = (i: string) => r.get(i) ?? g.anchors.get(i)?.rating ?? 1200;
  let ll = 0, acc = 0, swing = 0, nn = 0; const hist = new Map<string, number[]>();
  for (const x of g.m) {
    for (const i of [...x.a, ...x.b]) { const a = g.anchors.get(i); if (a && a.setAt !== null && x.at >= a.setAt && !ap.has(i)) { r.set(i, a.rating); ap.add(i); } }
    const ra = (get(x.a[0]) + get(x.a[1])) / 2, rb = (get(x.b[0]) + get(x.b[1])) / 2;
    const e = 1 / (1 + 10 ** ((rb - ra) / S)), y = x.w === 'A' ? 1 : 0;
    ll += -(y * Math.log(Math.max(e, 1e-9)) + (1 - y) * Math.log(Math.max(1 - e, 1e-9)));
    if (e !== 0.5) acc += (e > 0.5) === (y === 1) ? 1 : 0;
    const d = K * (y - e); swing += Math.abs(d); nn++;
    for (const i of x.a) r.set(i, get(i) + d); for (const i of x.b) r.set(i, get(i) - d);
  }
  const v = [...r.values()].sort((a, b) => a - b);
  return { ll: ll / g.m.length, acc: acc / g.m.length, avgMove: swing / nn, min: v[0], max: v.at(-1)!, r };
}
const f = (x: number) => x.toFixed(4);
console.log('K     | A ll  acc   | B ll   acc   | avg |delta|/match | B spread');
for (const K of [16, 32, 64, 128, 192, 256, 384, 512]) { const a = run(G.A, K), b = run(G.B, K); console.log(String(K).padEnd(5), '|', f(a.ll), (a.acc * 100).toFixed(0) + '%', '|', f(b.ll), (b.acc * 100).toFixed(0) + '%', '|', ((a.avgMove + b.avgMove) / 2).toFixed(1).padEnd(6), '|', b.min.toFixed(0), '-', b.max.toFixed(0)); }
console.log('\nK=32 with smaller scale S (same ranking, wider probabilities):');
for (const S of [400, 300, 200, 150]) { const a = run(G.A, 32, S), b = run(G.B, 32, S); console.log(`S=${S}`.padEnd(6), f(a.ll), f(b.ll)); }
// rank agreement K=16 vs K=64 final ordering, B
const rk = (m: Map<string, number>) => { const s = [...m].sort((a, b) => b[1] - a[1]).map(([i]) => i); return new Map(s.map((i, j) => [i, j])); };
for (const [nm, g] of Object.entries(G)) { const a = rk(run(g, 16).r), b = rk(run(g, 64).r); let d = 0; for (const [i, j] of a) d += (j - b.get(i)!) ** 2; const n = a.size; console.log(nm, 'spearman final order K16 vs K64:', (1 - 6 * d / (n * (n * n - 1))).toFixed(3)); }
