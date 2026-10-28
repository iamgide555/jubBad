/**
 * Elo K sweep: constant and decaying K, cross-group check, logistic scale.
 *
 * Scores online log-loss for constant K, a games-played decaying K, and the
 * logistic divisor, across two groups, and tunes on one group to score the other.
 *
 * Usage:
 *   node --experimental-strip-types --no-warnings engines/evidence/elo-k-sweep.mts <db> <groupA> <groupB>
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
  const m = rows.map((r) => ({ a: JSON.parse(r.teamA), b: JSON.parse(r.teamB), w: r.winner, at: Date.parse(r.confirmedAt) }))
    .filter((x) => (x.w === 'A' || x.w === 'B') && x.a.length === 2);
  return { anchors, m };
}
const groups = { A: load(process.argv[3]), B: load(process.argv[4]) };
type Sched = (n: number) => number;
function run(g: { anchors: Map<string, any>; m: any[] }, kf: Sched, S = 400) {
  const r = new Map<string, number>(), applied = new Set<string>(), n = new Map<string, number>();
  const get = (i: string) => r.get(i) ?? g.anchors.get(i)?.rating ?? 1200;
  let ll = 0, br = 0, llE = 0, cE = 0, llL = 0, cL = 0; let idx = 0;
  for (const x of g.m) {
    for (const i of [...x.a, ...x.b]) { const a = g.anchors.get(i); if (a && a.setAt !== null && x.at >= a.setAt && !applied.has(i)) { r.set(i, a.rating); applied.add(i); } }
    const ra = (get(x.a[0]) + get(x.a[1])) / 2, rb = (get(x.b[0]) + get(x.b[1])) / 2;
    const e = 1 / (1 + 10 ** ((rb - ra) / S)); const y = x.w === 'A' ? 1 : 0;
    const l = -(y * Math.log(Math.max(e, 1e-9)) + (1 - y) * Math.log(Math.max(1 - e, 1e-9)));
    ll += l; br += (y - e) ** 2; if (idx < 40) { llE += l; cE++; } else { llL += l; cL++; } idx++;
    for (const i of x.a) { r.set(i, get(i) + kf(n.get(i) ?? 0) * (y - e)); n.set(i, (n.get(i) ?? 0) + 1); }
    for (const i of x.b) { r.set(i, get(i) - kf(n.get(i) ?? 0) * (y - e)); n.set(i, (n.get(i) ?? 0) + 1); }
  }
  const N = g.m.length; return { ll: ll / N, br: br / N, early: llE / cE, late: llL / cL, N, ratings: r };
}
const gs = Object.entries(groups);
const evalAll = (kf: Sched, S = 400) => { const o = gs.map(([k, g]) => [k, run(g, kf, S)] as const); return { per: Object.fromEntries(o), avg: o.reduce((s, [, v]) => s + v.ll, 0) / o.length }; };
const f = (x: number) => x.toFixed(4);
const base = evalAll(() => 16);
console.log('baseline K=16 logloss  A', f(base.per['A'].ll), ' B', f(base.per['B'].ll), ' avg', f(base.avg));

console.log('\n== constant K ==');
for (const K of [16, 32, 48, 64, 96, 128]) { const e = evalAll(() => K); console.log(`K=${K}`.padEnd(7), 'A', f(e.per['A'].ll), 'B', f(e.per['B'].ll), 'avg', f(e.avg), '| B early40', f(e.per['B'].early), 'late', f(e.per['B'].late)); }

console.log('\n== decaying K(n)=Kmin+(Kmax-Kmin)*exp(-n/tau), n = player games so far ==');
const res: any[] = [];
for (const Kmax of [48, 64, 96, 128]) for (const Kmin of [8, 16, 24, 32]) for (const tau of [8, 15, 25, 40, 80]) {
  if (Kmin >= Kmax) continue;
  const kf = (n: number) => Kmin + (Kmax - Kmin) * Math.exp(-n / tau);
  const e = evalAll(kf); res.push({ Kmax, Kmin, tau, mama: e.per['A'].ll, thu: e.per['B'].ll, avg: e.avg, thuE: e.per['B'].early, thuL: e.per['B'].late });
}
res.sort((a, b) => a.avg - b.avg);
console.table(res.slice(0, 10).map((r) => ({ Kmax: r.Kmax, Kmin: r.Kmin, tau: r.tau, mama: f(r.mama), thu: f(r.thu), avg: f(r.avg), 'thu early40': f(r.thuE), 'thu late': f(r.thuL) })));
const bestConst = [16, 32, 48, 64, 96, 128].map((K) => ({ K, avg: evalAll(() => K).avg })).sort((a, b) => a.avg - b.avg)[0];
console.log('best constant:', bestConst.K, f(bestConst.avg), ' best decaying:', f(res[0].avg));

console.log('\n== cross-group check: tune on one, score on other ==');
for (const [tr, te] of [['A', 'B'], ['B', 'A']] as const) {
  const cand = res.map((r) => { const kf = (n: number) => r.Kmin + (r.Kmax - r.Kmin) * Math.exp(-n / r.tau); return { ...r, trainLL: run((groups as any)[tr], kf).ll, testLL: run((groups as any)[te], kf).ll }; }).sort((a, b) => a.trainLL - b.trainLL)[0];
  const constC = [16, 32, 48, 64, 96, 128].map((K) => ({ K, tr: run((groups as any)[tr], () => K).ll, te: run((groups as any)[te], () => K).ll })).sort((a, b) => a.tr - b.tr)[0];
  console.log(`train ${tr}: best decay Kmax=${cand.Kmax} Kmin=${cand.Kmin} tau=${cand.tau} -> test ${te} ll ${f(cand.testLL)} | best const K=${constC.K} -> test ${f(constC.te)} | K=16 -> test ${f(run((groups as any)[te], () => 16).ll)}`);
}

console.log('\n== logistic scale (K=16 constant) ==');
for (const S of [400, 300, 250, 200]) { const e = evalAll(() => 16, S); console.log(`S=${S}`.padEnd(7), 'A', f(e.per['A'].ll), 'B', f(e.per['B'].ll)); }

const pick = res[0]; const kf = (n: number) => pick.Kmin + (pick.Kmax - pick.Kmin) * Math.exp(-n / pick.tau);
console.log(`\nK(n) of best: n=0:${kf(0).toFixed(0)} 10:${kf(10).toFixed(0)} 25:${kf(25).toFixed(0)} 50:${kf(50).toFixed(0)} 100:${kf(100).toFixed(0)}`);
const sample = run(groups['B'], kf).ratings; const vals = [...sample.values()].sort((a, b) => a - b);
console.log('B rating spread under best decay: min', vals[0].toFixed(0), 'max', vals.at(-1)!.toFixed(0));
