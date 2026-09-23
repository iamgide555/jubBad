/**
 * Per-person bill for one session (roadmap C3). Pure: the server stores only
 * the inputs and recomputes on every read, the same rule as ratings.
 * Integer satang throughout. See the C3 section of
 * docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md.
 */

export const BILL_MODELS = ['fair', 'perGame', 'buffet'] as const;
export type BillModel = (typeof BILL_MODELS)[number];
export const SPLIT_MODES = ['equal', 'byGames'] as const;
export type SplitMode = (typeof SPLIT_MODES)[number];
export const ROUNDING_STEPS = [1, 5, 10] as const;
export type RoundingStep = (typeof ROUNDING_STEPS)[number];

export interface BillOverride {
  playerId: string;
  amountSatang: number;
}

export interface BillConfig {
  model: BillModel;
  /** Actual court cost. Split in `fair`; used for the margin in every model. */
  courtFeeSatang: number | null;
  courtSplit: SplitMode;
  shuttleSplit: SplitMode;
  perGameRateSatang: number;
  entryFeeSatang: number;
  capSatang: number | null;
  buffetPriceSatang: number;
  buffetShuttlesIncluded: boolean;
  hostFeeSatang: number;
  walkInFeeSatang: number;
  roundingBaht: RoundingStep;
  addedIds: string[];
  removedIds: string[];
  overrides: BillOverride[];
}

export const DEFAULT_BILL_CONFIG: BillConfig = {
  model: 'fair',
  courtFeeSatang: null,
  courtSplit: 'equal',
  shuttleSplit: 'byGames',
  perGameRateSatang: 0,
  entryFeeSatang: 0,
  capSatang: null,
  buffetPriceSatang: 0,
  buffetShuttlesIncluded: true,
  hostFeeSatang: 0,
  walkInFeeSatang: 2000,
  roundingBaht: 1,
  addedIds: [],
  removedIds: [],
  overrides: [],
};

/** Every player id on court in one confirmed, finished match. */
export interface BillMatch {
  players: string[];
}

export interface BillInput {
  config: BillConfig;
  matches: BillMatch[];
  walkInIds: string[];
  shuttleCount: number | null;
  shuttlePriceSatang: number | null;
}

export type BillWarning = 'MISSING_COURT_FEE' | 'MISSING_SHUTTLE_COUNT' | 'MISSING_SHUTTLE_PRICE';

export interface BillRow {
  playerId: string;
  games: number;
  status: 'billed' | 'removed';
  added: boolean;
  walkIn: boolean;
  courtSatang: number;
  shuttleSatang: number;
  /** Model share: court + shuttles (fair), entry + per-game capped (perGame), price (+ shuttles) (buffet). */
  baseSatang: number;
  hostFeeSatang: number;
  walkInFeeSatang: number;
  walkInDiscountSatang: number;
  overridden: boolean;
  /** Final amount to pay: rounded, or the override. 0 when removed. */
  amountSatang: number;
}

export interface BillResult {
  rows: BillRow[];
  totals: {
    collectedSatang: number;
    costSatang: number | null;
    marginSatang: number | null;
    billedCount: number;
    walkInCount: number;
  };
  warnings: BillWarning[];
}

/** Largest-remainder equal split: sums to `total` exactly; extra satang go to the first entries. */
export function splitEqual(total: number, n: number): number[] {
  if (n === 0) return [];
  const q = Math.floor(total / n);
  const r = total - q * n;
  return Array.from({ length: n }, (_, i) => q + (i < r ? 1 : 0));
}

/** Largest-remainder weighted split, integer-exact. All-zero weights fall back to equal. */
export function splitByWeight(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return splitEqual(total, weights.length);
  const out = weights.map((w) => Math.floor((total * w) / sum));
  let rest = total - out.reduce((a, b) => a + b, 0);
  const order = weights
    .map((w, i) => ({ i, rem: (total * w) % sum }))
    .sort((x, y) => y.rem - x.rem || x.i - y.i);
  for (const { i } of order) {
    if (rest === 0) break;
    out[i]++;
    rest--;
  }
  return out;
}

function assertMoney(label: string, v: number | null): void {
  if (v === null) return;
  if (!Number.isInteger(v) || v < 0) throw new Error(`bill: ${label} must be a non-negative integer, got ${v}`);
}

function assertUnique(label: string, ids: string[]): void {
  if (new Set(ids).size !== ids.length) throw new Error(`bill: duplicate id in ${label}`);
  if (ids.some((id) => id === '')) throw new Error(`bill: empty id in ${label}`);
}

function validate(input: BillInput): void {
  const c = input.config;
  if (!BILL_MODELS.includes(c.model)) throw new Error(`bill: unknown model ${c.model}`);
  if (!SPLIT_MODES.includes(c.courtSplit) || !SPLIT_MODES.includes(c.shuttleSplit)) {
    throw new Error('bill: unknown split mode');
  }
  if (!ROUNDING_STEPS.includes(c.roundingBaht)) throw new Error(`bill: unknown rounding ${c.roundingBaht}`);
  assertMoney('courtFeeSatang', c.courtFeeSatang);
  assertMoney('perGameRateSatang', c.perGameRateSatang);
  assertMoney('entryFeeSatang', c.entryFeeSatang);
  assertMoney('capSatang', c.capSatang);
  assertMoney('buffetPriceSatang', c.buffetPriceSatang);
  assertMoney('hostFeeSatang', c.hostFeeSatang);
  assertMoney('walkInFeeSatang', c.walkInFeeSatang);
  assertMoney('shuttleCount', input.shuttleCount);
  assertMoney('shuttlePriceSatang', input.shuttlePriceSatang);
  for (const o of c.overrides) assertMoney(`override ${o.playerId}`, o.amountSatang);
  assertUnique('addedIds', c.addedIds);
  assertUnique('removedIds', c.removedIds);
  assertUnique('overrides', c.overrides.map((o) => o.playerId));
  for (const match of input.matches) {
    if (match.players.length === 0) throw new Error('bill: match with no players');
    assertUnique('match players', match.players);
  }
}

/**
 * A cost (court or shuttles) split over participants, with any removed
 * person's share spread equally over the billed so the cost stays covered.
 */
function costShares(
  total: number,
  split: SplitMode,
  kind: 'court' | 'shuttle',
  participants: string[],
  billed: string[],
  games: Map<string, number>,
  matches: BillMatch[]
): Map<string, number> {
  const raw = new Map(participants.map((id) => [id, 0]));
  if (participants.length === 0) return raw;
  const totalGames = participants.reduce((s, id) => s + (games.get(id) ?? 0), 0);
  if (split === 'equal' || totalGames === 0) {
    splitEqual(total, participants.length).forEach((v, i) => raw.set(participants[i], v));
  } else if (kind === 'court') {
    splitByWeight(total, participants.map((id) => games.get(id) ?? 0)).forEach((v, i) =>
      raw.set(participants[i], v)
    );
  } else {
    const perMatch = splitEqual(total, matches.length);
    matches.forEach((match, k) => {
      splitEqual(perMatch[k], match.players.length).forEach((v, j) => {
        const id = match.players[j];
        raw.set(id, (raw.get(id) ?? 0) + v);
      });
    });
  }
  const billedSet = new Set(billed);
  const removedTotal = participants.filter((id) => !billedSet.has(id)).reduce((s, id) => s + raw.get(id)!, 0);
  const extra = splitEqual(removedTotal, billed.length);
  const out = new Map<string, number>();
  for (const id of participants) out.set(id, billedSet.has(id) ? raw.get(id)! : 0);
  billed.forEach((id, i) => out.set(id, out.get(id)! + extra[i]));
  return out;
}

function ceilTo(amount: number, step: number): number {
  return Math.ceil(amount / step) * step;
}

/**
 * Splits `pool` equally over the entries, never giving any entry more than
 * its cap; what a capped entry can't take is re-split over the rest.
 * Throws if the caps can't absorb the pool (the walk-in fee guarantees they
 * can: each walk-in's cap includes the fee it pays in).
 */
export function distributeCapped(pool: number, caps: number[]): number[] {
  const out = caps.map(() => 0);
  let remaining = pool;
  let open = caps.map((_, i) => i).filter((i) => caps[i] > 0);
  while (remaining > 0 && open.length > 0) {
    const shares = splitEqual(remaining, open.length);
    let given = 0;
    const next: number[] = [];
    open.forEach((idx, k) => {
      const add = Math.min(caps[idx] - out[idx], shares[k]);
      out[idx] += add;
      given += add;
      if (out[idx] < caps[idx]) next.push(idx);
    });
    remaining -= given;
    open = next;
  }
  if (remaining !== 0) throw new Error('bill: walk-in discount could not be distributed');
  return out;
}

export function computeBill(input: BillInput): BillResult {
  validate(input);
  const { config, matches, shuttleCount, shuttlePriceSatang } = input;

  const games = new Map<string, number>();
  for (const match of matches) for (const id of match.players) games.set(id, (games.get(id) ?? 0) + 1);
  const added = new Set(config.addedIds);
  const participants = [...new Set([...games.keys(), ...config.addedIds])].sort();
  const removed = new Set(config.removedIds);
  const billed = participants.filter((id) => !removed.has(id));

  const warnings: BillWarning[] = [];
  const shuttlesBilled = config.model === 'fair' || (config.model === 'buffet' && !config.buffetShuttlesIncluded);
  if (config.model === 'fair' && config.courtFeeSatang === null) warnings.push('MISSING_COURT_FEE');
  if (shuttlesBilled && shuttleCount === null) warnings.push('MISSING_SHUTTLE_COUNT');
  if (shuttlesBilled && shuttlePriceSatang === null) warnings.push('MISSING_SHUTTLE_PRICE');

  const shuttleTotal = (shuttleCount ?? 0) * (shuttlePriceSatang ?? 0);
  const court =
    config.model === 'fair'
      ? costShares(config.courtFeeSatang ?? 0, config.courtSplit, 'court', participants, billed, games, matches)
      : new Map<string, number>();
  const shuttle = shuttlesBilled
    ? costShares(shuttleTotal, config.shuttleSplit, 'shuttle', participants, billed, games, matches)
    : new Map<string, number>();

  const overrides = new Map(config.overrides.map((o) => [o.playerId, o.amountSatang]));
  const step = config.roundingBaht * 100;

  const pre = new Map<string, number>();
  const baseOf = new Map<string, number>();
  for (const id of participants) {
    const g = games.get(id) ?? 0;
    const shuttleSatang = shuttle.get(id) ?? 0;
    let base = 0;
    if (config.model === 'fair') base = (court.get(id) ?? 0) + shuttleSatang;
    else if (config.model === 'perGame') {
      const raw = config.entryFeeSatang + g * config.perGameRateSatang;
      base = config.capSatang === null ? raw : Math.min(raw, config.capSatang);
    } else base = config.buffetPriceSatang + shuttleSatang;
    baseOf.set(id, base);
    pre.set(id, base + config.hostFeeSatang);
  }

  // Walk-in surcharge is a group discount, not host profit: the fee each
  // walk-in pays is redistributed to the rest of the billed players, capped
  // per person so nobody's amount goes negative.
  const walkIns = new Set(input.walkInIds);
  const eligible = billed.filter((id) => !overrides.has(id));
  const eligibleWalkIns = eligible.filter((id) => walkIns.has(id));
  const fee = config.walkInFeeSatang;
  const pool = fee * eligibleWalkIns.length;
  const caps = eligible.map((id) => pre.get(id)! + (walkIns.has(id) ? fee : 0));
  const discount = new Map<string, number>();
  distributeCapped(pool, caps).forEach((d, i) => discount.set(eligible[i], d));

  const rows: BillRow[] = participants.map((id) => {
    const isBilled = !removed.has(id);
    const overridden = isBilled && overrides.has(id);
    const isWalkIn = isBilled && !overridden && walkIns.has(id);
    const walkInFeeSatang = isWalkIn ? fee : 0;
    const walkInDiscountSatang = discount.get(id) ?? 0;
    const amountSatang = !isBilled
      ? 0
      : overridden
        ? overrides.get(id)!
        : ceilTo(pre.get(id)! - walkInDiscountSatang + walkInFeeSatang, step);
    return {
      playerId: id,
      games: games.get(id) ?? 0,
      status: isBilled ? 'billed' : 'removed',
      added: added.has(id) && !games.has(id),
      walkIn: isWalkIn,
      courtSatang: court.get(id) ?? 0,
      shuttleSatang: shuttle.get(id) ?? 0,
      baseSatang: isBilled ? baseOf.get(id)! : 0,
      hostFeeSatang: isBilled ? config.hostFeeSatang : 0,
      walkInFeeSatang,
      walkInDiscountSatang,
      overridden,
      amountSatang,
    };
  });

  const collectedSatang = rows.reduce((s, r) => s + r.amountSatang, 0);
  const costSatang =
    config.courtFeeSatang === null || shuttleCount === null || shuttlePriceSatang === null
      ? null
      : config.courtFeeSatang + shuttleTotal;
  return {
    rows,
    totals: {
      collectedSatang,
      costSatang,
      marginSatang: costSatang === null ? null : collectedSatang - costSatang,
      billedCount: billed.length,
      walkInCount: eligibleWalkIns.length,
    },
    warnings,
  };
}
