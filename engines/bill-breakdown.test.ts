import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBill, DEFAULT_BILL_CONFIG, BILL_MODELS, type BillConfig, type BillInput, type BillMatch, type SettledPayment } from './bill.ts';
// The host-facing breakdown lives with the web app but is pure; it is checked here against the real engine.
import { billBreakdown } from '../web/src/app/core/bill-breakdown.ts';

// Deterministic sweep: a fixed-seed generator so a failure reproduces.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const PLAYERS = ['a', 'b', 'c', 'd', 'e', 'f'];

function scenario(seed: number): BillInput {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const money = (maxBaht: number) => Math.floor(r() * maxBaht) * 100 + (r() < 0.3 ? 25 : 0);
  const model = pick(BILL_MODELS);
  const tracked = model === 'perShuttle' || r() < 0.5;
  const matches: BillMatch[] = Array.from({ length: 4 + Math.floor(r() * 5) }, (_, i) => {
    const four = [...PLAYERS].sort(() => r() - 0.5).slice(0, 4);
    return tracked ? { players: four, shuttleIds: r() < 0.8 ? [`s${i % 3}`] : [] } : { players: four };
  });
  const playing = [...new Set(matches.flatMap((m) => m.players))];
  const absentPool = PLAYERS.filter((p) => !playing.includes(p));
  const config: BillConfig = {
    ...DEFAULT_BILL_CONFIG,
    model,
    courtFeeSatang: money(2000) + 100,
    courtSplit: pick(['equal', 'byGames'] as const),
    shuttleSplit: pick(['equal', 'byGames'] as const),
    perGameRateSatang: money(30) + 100,
    entryFeeSatang: r() < 0.5 ? money(40) : 0,
    capSatang: r() < 0.5 ? money(120) + 3000 : null,
    buffetPriceSatang: money(200) + 500,
    buffetShuttlesIncluded: r() < 0.5,
    startingFeeSatang: money(60),
    shuttleCharge: pick(['shared', 'full'] as const),
    perPlayerShuttleSatang: r() < 0.5 ? money(20) + 100 : null,
    hostFeeSatang: r() < 0.5 ? money(30) : 0,
    walkInFeeSatang: r() < 0.5 ? money(40) : 0,
    roundingBaht: pick([1, 5, 10] as const),
    absentIds: r() < 0.5 ? absentPool.slice(0, 1) : [],
    overrides: r() < 0.3 ? [{ playerId: playing[0], amountSatang: money(150) }] : [],
  };
  const settled: SettledPayment[] =
    r() < 0.3
      ? [{ id: 'r1', playerId: playing[playing.length - 1], model: 'buffet', amountSatang: 10000, settledAt: 'x', walkInFeeSatang: 0, walkInDiscountSatang: 0 }]
      : [];
  return {
    config,
    matches,
    walkInIds: playing.filter(() => r() < 0.3),
    shuttleCount: 12,
    shuttlePriceSatang: 8500,
    shuttleAllocation: tracked ? 'identities' : 'legacy',
    settled,
  };
}

test('breakdown lines add up to the engine amount for every billed row', () => {
  let billedRows = 0;
  for (let seed = 1; seed <= 1500; seed++) {
    const input = scenario(seed);
    const { rows } = computeBill(input);
    for (const row of rows) {
      if (row.status !== 'billed') continue;
      billedRows++;
      const b = billBreakdown(row as never, input.config as never, input.shuttlePriceSatang);
      const where = `seed ${seed} ${input.config.model} player ${row.playerId}`;
      if (row.overridden) {
        // The override replaces the whole sum, so the lines are what it would have been: still whole steps.
        assert.equal(b.computedSatang % (input.config.roundingBaht * 100), 0, where);
        assert.equal(b.overridden, true, where);
      } else {
        assert.equal(b.computedSatang, row.amountSatang, where);
        assert.equal(b.overridden, false, where);
      }
    }
  }
  assert.ok(billedRows > 5000, `sweep too thin: ${billedRows} rows`);
});

test('full shuttle charge: count times rate is the shuttle line', () => {
  let checked = 0;
  for (let seed = 1; seed <= 1500; seed++) {
    const input = scenario(seed);
    if (input.config.model !== 'perShuttle' || input.config.shuttleCharge !== 'full') continue;
    for (const row of computeBill(input).rows) {
      if (row.status !== 'billed' || row.shuttleSatang === 0) continue;
      const line = billBreakdown(row as never, input.config as never, input.shuttlePriceSatang).lines.find((l) => l.kind === 'shuttle')!;
      assert.equal(line.count! * line.rateSatang!, line.amountSatang, `seed ${seed}`);
      assert.ok(Number.isInteger(line.count), `seed ${seed}: count ${line.count}`);
      checked++;
    }
  }
  assert.ok(checked > 50, `sweep too thin: ${checked}`);
});
