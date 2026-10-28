/**
 * Tag accuracy: how well host-set levels match results.
 *
 * Regresses each tagged player's level seed on skill fitted from their results
 * (regularised, bootstrap uncertainty removed) to estimate the slope and noise of
 * real tags, and whether each tag was set before or after the player's first match.
 *
 * Usage:
 *   node --experimental-strip-types --no-warnings engines/evidence/tag-accuracy.mts <db> <groupCode>
 *
 * <db> is a copy of a production backup (see engines/evidence/README.md).
 * Read-only; never commit the database or this script's output.
 */
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const G = process.argv[3];
const players = db.prepare('select id,name,level,levelSeed,levelSetAt from Player where groupId=?').all(G) as any[];
const rows = db.prepare(`select p.teamA,p.teamB,p.winner,p.confirmedAt from Pairing p join Session s on s.code=p.sessionId where s.groupId=? and p.confirmedAt is not null and p.endedAt is not null order by p.confirmedAt`).all(G) as any[];
const M = rows.map((r) => ({ a: JSON.parse(r.teamA), b: JSON.parse(r.teamB), y: r.winner === 'A' ? 1 : 0, ok: r.winner === 'A' || r.winner === 'B', at: Date.parse(r.confirmedAt) })).filter((x) => x.ok && x.a.length === 2);
const K = 400 / Math.LN10;
function fit(ms: typeof M) {
  const s = new Map<string, number>(); for (const x of ms) for (const i of [...x.a, ...x.b]) s.set(i, 0);
  for (let it = 0; it < 2000; it++) {
    const g = new Map<string, number>(); for (const i of s.keys()) g.set(i, -0.5 * s.get(i)!);
    for (const x of ms) { const d = (s.get(x.a[0])! + s.get(x.a[1])! - s.get(x.b[0])! - s.get(x.b[1])!) / 2; const e = x.y - 1 / (1 + Math.exp(-d)); for (const i of x.a) g.set(i, g.get(i)! + e / 2); for (const i of x.b) g.set(i, g.get(i)! - e / 2); }
    for (const i of s.keys()) s.set(i, s.get(i)! + 0.05 * g.get(i)!);
  }
  return new Map([...s].map(([i, v]) => [i, v * K]));
}
const full = fit(M);
let seed = 1; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const boots: Map<string, number>[] = []; for (let b = 0; b < 40; b++) boots.push(fit(M.map(() => M[Math.floor(rnd() * M.length)])));
const games = new Map<string, number>(); for (const x of M) for (const i of [...x.a, ...x.b]) games.set(i, (games.get(i) ?? 0) + 1);
const firstAt = new Map<string, number>(); for (const x of M) for (const i of [...x.a, ...x.b]) if (!firstAt.has(i)) firstAt.set(i, x.at);
const tbl = players.filter((p) => full.has(p.id) && p.levelSeed !== null).map((p) => {
  const vals = boots.map((m) => m.get(p.id)).filter((v) => v !== undefined) as number[]; const mu = vals.reduce((a, b) => a + b, 0) / vals.length;
  const se = Math.sqrt(vals.reduce((a, b) => a + (b - mu) ** 2, 0) / vals.length);
  const before = M.filter((x) => [...x.a, ...x.b].includes(p.id) && p.levelSetAt && x.at < Date.parse(p.levelSetAt)).length;
  return { name: p.name, level: p.level, seed: p.levelSeed as number, fit: full.get(p.id)!, se, g: games.get(p.id)!, before, setBeforeFirst: p.levelSetAt ? Date.parse(p.levelSetAt) <= firstAt.get(p.id)! : null };
});
// regress seed on fit (OLS), weight equal
const n = tbl.length, mx = tbl.reduce((a, r) => a + r.fit, 0) / n, my = tbl.reduce((a, r) => a + r.seed, 0) / n;
const b = tbl.reduce((a, r) => a + (r.fit - mx) * (r.seed - my), 0) / tbl.reduce((a, r) => a + (r.fit - mx) ** 2, 0), a0 = my - b * mx;
const res = tbl.map((r) => ({ ...r, resid: r.seed - (a0 + b * r.fit) }));
const sd = (v: number[]) => Math.sqrt(v.reduce((a, c) => a + c * c, 0) / v.length);
const rawSd = sd(res.map((r) => r.resid)), seMean = Math.sqrt(res.reduce((a, r) => a + (b * r.se) ** 2, 0) / n);
console.log(`players with tag & games: ${n}; seed = ${a0.toFixed(0)} + ${b.toFixed(2)} * fitted skill`);
console.log(`residual sd of tags vs results: ${rawSd.toFixed(0)} pts; mean fit uncertainty (bootstrap, scaled) ${seMean.toFixed(0)} pts; tag-noise estimate ${Math.sqrt(Math.max(0, rawSd ** 2 - seMean ** 2)).toFixed(0)} pts (level step = 100)`);
const rk = (v: number[]) => v.map((x) => v.filter((y) => y > x).length); const ra = rk(tbl.map((r) => r.seed)), rb = rk(tbl.map((r) => r.fit)); const dd = ra.reduce((s, x, i) => s + (x - rb[i]) ** 2, 0);
console.log('spearman(seed, fitted):', (1 - 6 * dd / (n * (n * n - 1))).toFixed(2));
console.table(res.sort((x, y) => y.seed - x.seed).map((r) => ({ lvl: r.level, seed: r.seed, g: r.g, 'games before tag set': r.before, 'tag set before 1st match': r.setBeforeFirst, 'fit(pts)': Math.round(r.fit), 'se': Math.round(r.se), 'tag err vs fit': Math.round(r.resid) })));
const pre = res.filter((r) => r.setBeforeFirst), post = res.filter((r) => !r.setBeforeFirst);
console.log('tag set before first match: n=', pre.length, 'resid sd', pre.length ? sd(pre.map((r) => r.resid)).toFixed(0) : '-', '| set after watching play: n=', post.length, 'resid sd', post.length ? sd(post.map((r) => r.resid)).toFixed(0) : '-');
const long = res.filter((r) => r.g >= 30); console.log('players with 30+ games: n=', long.length, 'resid sd', sd(long.map((r) => r.resid)).toFixed(0));
