/**
 * Pairing simulation: does Elo tuning or level tagging change true match fairness?
 *
 * Fits each group's true skill from its real matches (regularised), then runs the
 * real generateRound in balanced mode over 8 nights x 8 rounds x 3 courts, drawing
 * outcomes from true skill while the engine sees only Elo ratings. Score is the mean
 * |P(A wins) - 0.5| per game by true skill (0 = fair), and in-session repeat-partner rate.
 * Slow: about 3 minutes per 10 seeds.
 *
 * Usage:
 *   node --experimental-strip-types --no-warnings engines/evidence/pairing-sim.mts <db> <groupA> <groupB> [seeds=6] [players=14]
 *
 * <db> is a copy of a production backup (see engines/evidence/README.md).
 * Read-only; never commit the database or this script's output.
 */
import { DatabaseSync } from 'node:sqlite';
import { generateRound, pairKey, type MatchHistory } from '../pairing.ts';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const GROUPS: Record<string, string> = { A: process.argv[3], B: process.argv[4] };
const SEEDS = Number(process.argv[5] ?? 6), NIGHTS = 8, ROUNDS = 8, COURTS = 3, N_PLAY = Number(process.argv[6] ?? 14);

function fitSkill(G: string) {
  const rows = db.prepare(`select p.teamA,p.teamB,p.winner from Pairing p join Session s on s.code=p.sessionId where s.groupId=? and p.confirmedAt is not null and p.endedAt is not null`).all(G) as any[];
  const m = rows.map((r) => ({ a: JSON.parse(r.teamA), b: JSON.parse(r.teamB), y: r.winner === 'A' ? 1 : 0, ok: r.winner === 'A' || r.winner === 'B' })).filter((x) => x.ok && x.a.length === 2);
  const games = new Map<string, number>(); for (const x of m) for (const i of [...x.a, ...x.b]) games.set(i, (games.get(i) ?? 0) + 1);
  const s = new Map<string, number>(); for (const i of games.keys()) s.set(i, 0);
  const lam = 0.5;
  for (let it = 0; it < 3000; it++) {
    const g = new Map<string, number>(); for (const i of s.keys()) g.set(i, -lam * (s.get(i)!));
    for (const x of m) {
      const d = (s.get(x.a[0])! + s.get(x.a[1])! - s.get(x.b[0])! - s.get(x.b[1])!) / 2; const p = 1 / (1 + Math.exp(-d)); const e = x.y - p;
      for (const i of x.a) g.set(i, g.get(i)! + e / 2); for (const i of x.b) g.set(i, g.get(i)! - e / 2);
    }
    for (const i of s.keys()) s.set(i, s.get(i)! + 0.05 * g.get(i)!);
  }
  // convert natural-log units to Elo points on 400 scale: p=1/(1+10^(-D/400)) => D = d*400/ln10
  const k = 400 / Math.LN10;
  const top = [...games].sort((a, b) => b[1] - a[1]).slice(0, N_PLAY).map(([i]) => i);
  const skill = new Map(top.map((i) => [i, s.get(i)! * k]));
  const mean = [...skill.values()].reduce((a, b) => a + b, 0) / skill.size; for (const i of skill.keys()) skill.set(i, skill.get(i)! - mean);
  const seed = new Map(db.prepare('select id,levelSeed from Player where groupId=?').all(G).map((p: any) => [p.id, p.levelSeed]));
  return { skill, hasLevels: [...seed.values()].some((v) => v !== null) };
}
function rng(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

type Cfg = { name: string; mode: 'variety' | 'balanced'; K: number; c: number; seeded: boolean; oracle?: boolean; slope?: number; sigma?: number };
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(Math.max(r(), 1e-9))) * Math.cos(2 * Math.PI * r());
function simulate(skill: Map<string, number>, cfg: Cfg, seed: number) {
  const ids = [...skill.keys()]; const rand = rng(seed * 7919 + 13);
  const rating = new Map<string, number>();
  for (const i of ids) rating.set(i, cfg.seeded ? Math.round(((cfg.slope === undefined ? 1200 + skill.get(i)! + (rand() - 0.5) * 150 : 1130 + cfg.slope * skill.get(i)! + gauss(rand) * cfg.sigma!)) / 100) * 100 : 1200);
  let trueImb = 0, repeat = 0, g = 0, gapSeen = 0; let lateImb = 0, lateN = 0;
  for (let n = 0; n < NIGHTS; n++) {
    const partner = new Map<string, number>(), opp = new Map<string, number>(), played = new Map<string, number>(ids.map((i) => [i, 0])), since = new Map<string, number>(ids.map((i) => [i, 0]));
    const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
    for (let r = 0; r < ROUNDS; r++) {
      const hist: MatchHistory = { partnerCounts: partner, opponentCounts: opp, gamesPlayedThisSession: played, waitingSince: since };
      let ratings: Map<string, number> | undefined;
      if (cfg.mode === 'balanced') { ratings = new Map(); const src = cfg.oracle ? skill : rating; const mean = [...src.values()].reduce((a, b) => a + b, 0) / src.size; for (const i of ids) ratings.set(i, mean + (src.get(i)! - mean) * cfg.c); }
      const res = generateRound(ids, COURTS, hist, rand, undefined, ratings);
      for (const ct of res.courts) {
        const A = ct.teamA, B = ct.teamB;
        const ta = (skill.get(A[0])! + skill.get(A[1])!) / 2, tb = (skill.get(B[0])! + skill.get(B[1])!) / 2;
        const pA = 1 / (1 + 10 ** ((tb - ta) / 400));
        const imb = Math.abs(pA - 0.5); trueImb += imb; g++; if (n >= NIGHTS / 2) { lateImb += imb; lateN++; }
        if ((partner.get(pairKey(A[0], A[1])) ?? 0) > 0) repeat++; if ((partner.get(pairKey(B[0], B[1])) ?? 0) > 0) repeat++;
        const y = rand() < pA ? 1 : 0;
        const ra = (rating.get(A[0])! + rating.get(A[1])!) / 2, rb = (rating.get(B[0])! + rating.get(B[1])!) / 2; gapSeen += Math.abs(ra - rb);
        const e = 1 / (1 + 10 ** ((rb - ra) / 400)); const d = cfg.K * (y - e);
        for (const i of A) rating.set(i, rating.get(i)! + d); for (const i of B) rating.set(i, rating.get(i)! - d);
        bump(partner, pairKey(A[0], A[1])); bump(partner, pairKey(B[0], B[1]));
        for (const a of A) for (const b of B) bump(opp, pairKey(a, b));
        for (const i of [...A, ...B]) { played.set(i, played.get(i)! + 1); since.set(i, r + 1); }
      }
    }
  }
  // rating quality at end: spearman vs true skill
  const rk = (m: Map<string, number>) => new Map([...m].sort((a, b) => b[1] - a[1]).map(([i], j) => [i, j] as [string, number]));
  const ra = rk(rating), rt = rk(skill); let dd = 0; for (const i of ids) dd += (ra.get(i)! - rt.get(i)!) ** 2; const nn = ids.length;
  return { imb: trueImb / g, late: lateImb / lateN, repeat: repeat / (2 * g), rho: 1 - 6 * dd / (nn * (nn * nn - 1)) };
}

const cfgs: Cfg[] = [
  { name: 'variety (no ratings)', mode: 'variety', K: 16, c: 1, seeded: false },
  { name: 'now: K16 c1', mode: 'balanced', K: 16, c: 1, seeded: false },
  { name: 'K16 c2', mode: 'balanced', K: 16, c: 2, seeded: false },
  { name: 'K16 c3', mode: 'balanced', K: 16, c: 3, seeded: false },
  { name: 'K32 c1', mode: 'balanced', K: 32, c: 1, seeded: false },
  { name: 'K32 c2', mode: 'balanced', K: 32, c: 2, seeded: false },
  { name: 'K32 c3', mode: 'balanced', K: 32, c: 3, seeded: false },
  { name: 'K64 c1', mode: 'balanced', K: 64, c: 1, seeded: false },
  { name: 'ORACLE true skill c1', mode: 'balanced', K: 16, c: 1, seeded: false, oracle: true },
  { name: 'ORACLE true skill c2', mode: 'balanced', K: 16, c: 2, seeded: false, oracle: true },
  { name: 'tags +-75 slope1 (assumed)', mode: 'balanced', K: 16, c: 1, seeded: true },
  { name: 'tags +-75 slope1, K32 c2', mode: 'balanced', K: 32, c: 2, seeded: true },
  { name: 'REAL tags s=.45 n=76', mode: 'balanced', K: 16, c: 1, seeded: true, slope: 0.45, sigma: 76 },
  { name: 'REAL tags s=.45 n=76, K32', mode: 'balanced', K: 32, c: 1, seeded: true, slope: 0.45, sigma: 76 },
  { name: 'REAL tags n=120 (worse)', mode: 'balanced', K: 16, c: 1, seeded: true, slope: 0.45, sigma: 120 },
  { name: 'REAL tags n=170 (poor)', mode: 'balanced', K: 16, c: 1, seeded: true, slope: 0.45, sigma: 170 },
];
for (const [nm, G] of Object.entries(GROUPS)) {
  const { skill } = fitSkill(G); const v = [...skill.values()].sort((a, b) => a - b);
  console.log(`\n### ${nm}: ${skill.size} players, fitted true skill spread ${v[0].toFixed(0)}..${v.at(-1)!.toFixed(0)} (sd ${Math.sqrt(v.reduce((a, b) => a + b * b, 0) / v.length).toFixed(0)}), ${NIGHTS} nights x ${ROUNDS} rounds x ${COURTS} courts, ${SEEDS} seeds`);
  console.log('config'.padEnd(24), 'trueImb(all)  trueImb(late)  repeatPartner  rankCorr');
  for (const cfg of cfgs) {
    let a = 0, l = 0, rp = 0, rho = 0;
    for (let s = 1; s <= SEEDS; s++) { const r = simulate(skill, cfg, s); a += r.imb; l += r.late; rp += r.repeat; rho += r.rho; }
    console.log(cfg.name.padEnd(24), (a / SEEDS).toFixed(3).padEnd(13), (l / SEEDS).toFixed(3).padEnd(13), ((rp / SEEDS) * 100).toFixed(0).padStart(3) + '%'.padEnd(10), (cfg.oracle ? 'n/a' : (rho / SEEDS).toFixed(2)));
  }
}
