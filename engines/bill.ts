/**
 * Per-person bill for one session (roadmap C3). Pure: the server stores only
 * the inputs and recomputes on every read, the same rule as ratings.
 * Integer satang throughout. See the C3 section of
 * docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md.
 */

export const BILL_MODELS = ['fair', 'perGame', 'buffet', 'perShuttle'] as const;
export type BillModel = (typeof BILL_MODELS)[number];
/**
 * What a player leaving early may be charged under. `fair` splits a whole
 * night's cost and cannot be quoted mid-session; `perShuttle` (advanced
 * sessions only) is a starting fee plus a share of the recorded distinct
 * shuttles the player's finished games used.
 */
export type CheckoutModel = Exclude<BillModel, 'fair'>;
export const SPLIT_MODES = ['equal', 'byGames'] as const;
export type SplitMode = (typeof SPLIT_MODES)[number];
export const SHUTTLE_CHARGES = ['shared', 'full'] as const;
export type ShuttleCharge = (typeof SHUTTLE_CHARGES)[number];
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
  /** perShuttle only: the flat fee every billed person pays before their shuttle share. */
  startingFeeSatang: number;
  /**
   * perShuttle only. 'shared' splits the recorded shuttle cost over the games
   * and players that used it; 'full' charges each player the whole charge for
   * every distinct shuttle in their finished games.
   */
  shuttleCharge: ShuttleCharge;
  /** perShuttle + full only: what one player pays per shuttle. null follows the session's shuttle price. */
  perPlayerShuttleSatang: number | null;
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
  startingFeeSatang: 0,
  shuttleCharge: 'shared',
  perPlayerShuttleSatang: null,
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
  /**
   * The distinct shuttle identities this game used. Omitted for an ordinary
   * (non-tracking) game; `null` for an advanced-session game whose use was
   * never recorded; `[]` for one recorded as using none. Opaque ids: the
   * engine only compares them, and orders them for stable remainders.
   */
  shuttleIds?: string[] | null;
}

/** Distinct shuttle ids across the games a player was in. A game with unknown use contributes none. */
export function distinctShuttlesFor(playerId: string, matches: BillMatch[]): number {
  const ids = new Set<string>();
  for (const match of matches) {
    if (!match.players.includes(playerId)) continue;
    for (const id of match.shuttleIds ?? []) ids.add(id);
  }
  return ids.size;
}

/** How shuttle cost was shared — reported so a bill can explain a fallback. */
export type ShuttleAllocation = 'legacy-basic' | 'legacy-unknown' | 'legacy-no-uses' | 'identities' | 'equal';

/**
 * An early checkout already collected (host feedback E): frozen, never
 * recomputed. Separate from `config.removedIds` on purpose -- removing someone
 * would redistribute their whole share and lose what they paid.
 */
export interface SettledPayment {
  id: string;
  playerId: string;
  model: CheckoutModel;
  amountSatang: number;
  settledAt: string;
  /** The walk-in surcharge inside `amountSatang`. */
  walkInFeeSatang: number;
  /** The walk-in discount already returned inside `amountSatang`. */
  walkInDiscountSatang: number;
  /**
   * The flat starting fee a perShuttle receipt embeds. It is the host's
   * per-person charge, not money toward the shuttle cost, so a final perShuttle
   * bill does not credit it against the shuttles (0 for other models).
   */
  startingFeeSatang?: number;
}

export interface BillInput {
  config: BillConfig;
  matches: BillMatch[];
  walkInIds: string[];
  shuttleCount: number | null;
  shuttlePriceSatang: number | null;
  /**
   * 'identities' shares one effective total over distinct shuttle ids, then
   * over the games that used each, then over each game's players. Anything
   * else (the default) keeps the pre-D equal-per-match split.
   */
  shuttleAllocation?: 'legacy' | 'identities';
  /** Current early-checkout receipts. Default none: the bill is then exactly the original. */
  settled?: SettledPayment[];
}

export type BillWarning =
  | 'MISSING_COURT_FEE'
  | 'MISSING_SHUTTLE_COUNT'
  | 'MISSING_SHUTTLE_PRICE'
  /** perShuttle: a finished game's shuttle use was never recorded, and no count may invent it. */
  | 'UNKNOWN_SHUTTLE_USE'
  /** Frozen payments exceed the cost they were credited against: a refund the host resolves outside the app. */
  | 'EXCESS_CREDIT'
  /** Nobody is left to pay the part of the cost the frozen payments did not cover. */
  | 'UNCOVERED_COST'
  /** Walk-in surcharge that nobody eligible can take back; never reported as host profit. */
  | 'UNRETURNED_SURCHARGE';

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
  /** The walk-in fee actually charged: the configured fee rounded up to a whole rounding step. */
  walkInFeeSatang: number;
  /** This person's share of the walk-in pool, in whole rounding steps. */
  walkInDiscountSatang: number;
  overridden: boolean;
  /** Final amount to pay: rounded, or the override. 0 when removed. */
  amountSatang: number;
}

export interface BillResult {
  /** People still due. A settled player is never a row: see `settledRows`. */
  rows: BillRow[];
  /** Early checkouts as they were frozen, passed through untouched. */
  settledRows: { id: string; playerId: string; model: CheckoutModel; amountSatang: number; settledAt: string }[];
  totals: {
    /** Settled once plus what is still due. */
    collectedSatang: number;
    settledTotalSatang: number;
    stillDueSatang: number;
    /** Frozen payments beyond the cost they were credited against (a refund to resolve by hand). */
    excessCreditSatang: number;
    /** Cost left with nobody still due to pay it. */
    uncoveredCostSatang: number;
    /** Walk-in surcharge nobody eligible could take back. */
    unreturnedSurchargeSatang: number;
    costSatang: number | null;
    marginSatang: number | null;
    /** People still due (settled ones are in `settledRows`). */
    billedCount: number;
    walkInCount: number;
  };
  warnings: BillWarning[];
  shuttleAllocation: ShuttleAllocation;
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
  if (!SHUTTLE_CHARGES.includes(c.shuttleCharge)) throw new Error(`bill: unknown shuttleCharge ${c.shuttleCharge}`);
  assertMoney('perPlayerShuttleSatang', c.perPlayerShuttleSatang);
  assertMoney('courtFeeSatang', c.courtFeeSatang);
  assertMoney('perGameRateSatang', c.perGameRateSatang);
  assertMoney('entryFeeSatang', c.entryFeeSatang);
  assertMoney('capSatang', c.capSatang);
  assertMoney('buffetPriceSatang', c.buffetPriceSatang);
  assertMoney('startingFeeSatang', c.startingFeeSatang);
  assertMoney('hostFeeSatang', c.hostFeeSatang);
  assertMoney('walkInFeeSatang', c.walkInFeeSatang);
  assertMoney('shuttleCount', input.shuttleCount);
  assertMoney('shuttlePriceSatang', input.shuttlePriceSatang);
  for (const o of c.overrides) assertMoney(`override ${o.playerId}`, o.amountSatang);
  assertUnique('addedIds', c.addedIds);
  assertUnique('removedIds', c.removedIds);
  assertUnique('overrides', c.overrides.map((o) => o.playerId));
  const settled = input.settled ?? [];
  assertUnique('settled', settled.map((r) => r.playerId));
  for (const r of settled) {
    if (!BILL_MODELS.includes(r.model) || r.model === ('fair' as string)) throw new Error(`bill: settled ${r.playerId} has unusable model ${r.model}`);
    assertMoney(`settled ${r.playerId} amount`, r.amountSatang);
    assertMoney(`settled ${r.playerId} walk-in fee`, r.walkInFeeSatang);
    assertMoney(`settled ${r.playerId} walk-in discount`, r.walkInDiscountSatang);
    assertMoney(`settled ${r.playerId} starting fee`, r.startingFeeSatang ?? 0);
  }
  for (const match of input.matches) {
    if (match.players.length === 0) throw new Error('bill: match with no players');
    assertUnique('match players', match.players);
    if (match.shuttleIds) assertUnique('match shuttleIds', match.shuttleIds);
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
  matches: BillMatch[],
  identities = false
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
  } else if (identities) {
    // One shuttle, one price: the effective total goes to each distinct
    // identity, each identity's share to the games that used it, and each
    // game's share to its players. Ids are sorted so remainders are stable.
    const ids = [...new Set(matches.flatMap((match) => match.shuttleIds ?? []))].sort();
    const perId = splitEqual(total, ids.length);
    ids.forEach((shuttleId, k) => {
      const using = matches.filter((match) => match.shuttleIds?.includes(shuttleId));
      const perGame = splitEqual(perId[k], using.length);
      using.forEach((match, g) => {
        splitEqual(perGame[g], match.players.length).forEach((v, j) => {
          const id = match.players[j];
          raw.set(id, (raw.get(id) ?? 0) + v);
        });
      });
    });
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
  const { out, remaining } = distributeCappedPartial(pool, caps);
  if (remaining !== 0) throw new Error('bill: walk-in discount could not be distributed');
  return out;
}

/** Like distributeCapped, but hands back what no entry could take instead of throwing. */
export function distributeCappedPartial(pool: number, caps: number[]): { out: number[]; remaining: number } {
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
  return { out, remaining };
}

export function computeBill(input: BillInput): BillResult {
  validate(input);
  const { config, matches, shuttleCount, shuttlePriceSatang } = input;
  const settled = input.settled ?? [];
  // A settled player is final: whatever the config still says about them
  // (removed, added, overridden) no longer applies -- they paid, and only an
  // explicit undo of the checkout can make them billable again.
  const settledIds = new Set(settled.map((r) => r.playerId));
  const settledTotal = settled.reduce((s, r) => s + r.amountSatang, 0);
  const perShuttle = config.model === 'perShuttle';
  const fullCharge = perShuttle && config.shuttleCharge === 'full';
  // Blank charge follows the session shuttle price.
  const chargeSatang = config.perPlayerShuttleSatang ?? shuttlePriceSatang;

  const games = new Map<string, number>();
  for (const match of matches) for (const id of match.players) games.set(id, (games.get(id) ?? 0) + 1);
  const added = new Set(config.addedIds);
  const participants = [...new Set([...games.keys(), ...config.addedIds])].sort();
  const removed = new Set(config.removedIds.filter((id) => !settledIds.has(id)));
  // Settled people stay in `billed` so the nominal cost shares still count them;
  // `due` is who actually gets a row.
  const billed = participants.filter((id) => !removed.has(id));
  const due = billed.filter((id) => !settledIds.has(id));

  const warnings: BillWarning[] = [];
  const shuttlesBilled = config.model === 'fair' || (config.model === 'buffet' && !config.buffetShuttlesIncluded);
  if (config.model === 'fair' && config.courtFeeSatang === null) warnings.push('MISSING_COURT_FEE');
  if (shuttlesBilled && shuttleCount === null) warnings.push('MISSING_SHUTTLE_COUNT');
  if (shuttlesBilled && shuttlePriceSatang === null) warnings.push('MISSING_SHUTTLE_PRICE');

  // perShuttle prices only what the games recorded -- distinct shuttle ids at the
  // session price -- never the physical count, and never an unknown game's use.
  const recordedIds = perShuttle ? [...new Set(matches.flatMap((m) => m.shuttleIds ?? []))].sort() : [];
  if (perShuttle) {
    if (matches.some((m) => m.shuttleIds === null)) warnings.push('UNKNOWN_SHUTTLE_USE');
    if (recordedIds.length > 0 && (fullCharge ? chargeSatang : shuttlePriceSatang) === null) warnings.push('MISSING_SHUTTLE_PRICE');
  }
  const recordedCost = recordedIds.length * (shuttlePriceSatang ?? 0);

  const shuttleTotal = (shuttleCount ?? 0) * (shuttlePriceSatang ?? 0);
  const allocation: ShuttleAllocation = perShuttle
    ? matches.some((m) => m.shuttleIds === null)
      ? 'legacy-unknown'
      : 'identities'
    : chooseShuttleAllocation(input, shuttlesBilled, shuttleTotal);
  const court =
    config.model === 'fair'
      ? costShares(config.courtFeeSatang ?? 0, config.courtSplit, 'court', participants, billed, games, matches)
      : new Map<string, number>();
  const shuttle = fullCharge
    ? new Map(billed.map((id) => [id, distinctShuttlesFor(id, matches) * (chargeSatang ?? 0)]))
    : perShuttle
      ? costShares(recordedCost, 'byGames', 'shuttle', participants, billed, games, matches, true)
      : shuttlesBilled
        ? costShares(shuttleTotal, config.shuttleSplit, 'shuttle', participants, billed, games, matches, allocation === 'identities')
        : new Map<string, number>();

  const overrides = new Map(config.overrides.filter((o) => !settledIds.has(o.playerId)).map((o) => [o.playerId, o.amountSatang]));
  const step = config.roundingBaht * 100;

  // Cost models with something already paid: the cost they cover, minus what
  // was frozen, is split over the people still due by their nominal shares.
  // (Nothing settled leaves the nominal shares untouched, byte for byte.)
  let excessCredit = 0;
  let uncoveredCost = 0;
  let courtOf = court;
  let shuttleOf = shuttle;
  // `full` is rate-based like perGame/buffet: nothing is derived from a total,
  // so a settled leaver stays frozen and no cost is re-covered from the others.
  const costModel = config.model === 'fair' || (perShuttle && !fullCharge);
  if (costModel && settled.length > 0) {
    const cost = perShuttle ? recordedCost : (config.courtFeeSatang ?? 0) + shuttleTotal;
    const credit = perShuttle ? settled.reduce((s, r) => s + r.amountSatang - (r.startingFeeSatang ?? 0), 0) : settledTotal;
    const residual = Math.max(0, cost - credit);
    const costKnown = perShuttle || config.courtFeeSatang !== null;
    excessCredit = costKnown ? Math.max(0, credit - cost) : 0;
    const nominal = (id: string) => (court.get(id) ?? 0) + (shuttle.get(id) ?? 0);
    const shares = splitByWeight(residual, due.map(nominal));
    courtOf = new Map();
    shuttleOf = new Map();
    due.forEach((id, i) => {
      const [c, sh] = splitByWeight(shares[i], [court.get(id) ?? 0, shuttle.get(id) ?? 0]);
      courtOf.set(id, c);
      shuttleOf.set(id, sh);
    });
    if (due.length === 0) uncoveredCost = costKnown ? residual : 0;
  }

  const pre = new Map<string, number>();
  const baseOf = new Map<string, number>();
  for (const id of due) {
    const g = games.get(id) ?? 0;
    const shuttleSatang = shuttleOf.get(id) ?? 0;
    let base = 0;
    if (config.model === 'fair') base = (courtOf.get(id) ?? 0) + shuttleSatang;
    else if (config.model === 'perGame') {
      const raw = config.entryFeeSatang + g * config.perGameRateSatang;
      base = config.capSatang === null ? raw : Math.min(raw, config.capSatang);
    } else if (perShuttle) {
      base = config.startingFeeSatang + shuttleSatang;
    } else base = config.buffetPriceSatang + shuttleSatang;
    baseOf.set(id, base);
    pre.set(id, base + config.hostFeeSatang);
  }

  // Walk-in surcharge is a group discount, not host profit: the fees the
  // walk-ins pay are pooled and handed back as a discount to every billed,
  // non-overridden player (walk-ins included), capped per person so nobody's
  // amount goes negative. The total collected must equal what it would be
  // with no walk-ins at all, for ANY rounding step -- so round first, then
  // move money only in whole steps. Each person's no-walk-in amount is
  // ceiled to the step, the fee itself is rounded up to a whole step, and
  // the pool is distributed in step units; every term is then a multiple of
  // the step and no further rounding can eat the discount. (Rounding after
  // redistributing, as an earlier version did, let the per-person ceil
  // swallow the discount while the walk-in still paid the full fee.)
  //
  // Early checkouts: a settled walk-in already paid their surcharge inside a
  // frozen amount. A cost model has credited it against the cost once, so it
  // adds nothing here; a price-based model owes it back to the people still
  // due, less any discount the receipt already returned.
  const walkIns = new Set(input.walkInIds);
  const eligible = due.filter((id) => !overrides.has(id));
  const eligibleWalkIns = eligible.filter((id) => walkIns.has(id));
  const rounded = new Map(due.map((id) => [id, ceilTo(pre.get(id)!, step)]));
  const feeSteps = config.walkInFeeSatang === 0 ? 0 : Math.ceil(config.walkInFeeSatang / step);
  // The fee actually charged: the configured fee rounded up to a whole step.
  const fee = feeSteps * step;
  const carried = costModel ? 0 : settled.reduce((s, r) => s + Math.max(0, r.walkInFeeSatang - r.walkInDiscountSatang), 0);
  const poolSteps = feeSteps * eligibleWalkIns.length + Math.floor(carried / step);
  const capsSteps = eligible.map((id) => rounded.get(id)! / step + (walkIns.has(id) ? feeSteps : 0));
  const handed = distributeCappedPartial(poolSteps, capsSteps);
  const discount = new Map<string, number>();
  handed.out.forEach((d, i) => discount.set(eligible[i], d * step));
  const unreturnedSurcharge = handed.remaining * step + (carried % step);
  if (unreturnedSurcharge > 0) warnings.push('UNRETURNED_SURCHARGE');
  if (excessCredit > 0) warnings.push('EXCESS_CREDIT');
  if (uncoveredCost > 0) warnings.push('UNCOVERED_COST');

  const rows: BillRow[] = participants.filter((id) => !settledIds.has(id)).map((id) => {
    const isBilled = !removed.has(id);
    const overridden = isBilled && overrides.has(id);
    const isWalkIn = isBilled && !overridden && walkIns.has(id);
    const walkInFeeSatang = isWalkIn ? fee : 0;
    const walkInDiscountSatang = discount.get(id) ?? 0;
    // Already a whole multiple of the step: rounded share, discount and fee all are.
    const amountSatang = !isBilled
      ? 0
      : overridden
        ? overrides.get(id)!
        : rounded.get(id)! - walkInDiscountSatang + walkInFeeSatang;
    return {
      playerId: id,
      games: games.get(id) ?? 0,
      status: isBilled ? 'billed' : 'removed',
      added: added.has(id) && !games.has(id),
      walkIn: isWalkIn,
      courtSatang: courtOf.get(id) ?? 0,
      shuttleSatang: shuttleOf.get(id) ?? 0,
      baseSatang: isBilled ? baseOf.get(id)! : 0,
      hostFeeSatang: isBilled ? config.hostFeeSatang : 0,
      walkInFeeSatang,
      walkInDiscountSatang,
      overridden,
      amountSatang,
    };
  });

  const stillDueSatang = rows.reduce((s, r) => s + r.amountSatang, 0);
  const collectedSatang = settledTotal + stillDueSatang;
  const costSatang =
    config.courtFeeSatang === null || shuttleCount === null || shuttlePriceSatang === null
      ? null
      : config.courtFeeSatang + shuttleTotal;
  return {
    rows,
    settledRows: settled.map((r) => ({ id: r.id, playerId: r.playerId, model: r.model, amountSatang: r.amountSatang, settledAt: r.settledAt })),
    totals: {
      collectedSatang,
      settledTotalSatang: settledTotal,
      stillDueSatang,
      excessCreditSatang: excessCredit,
      uncoveredCostSatang: uncoveredCost,
      unreturnedSurchargeSatang: unreturnedSurcharge,
      costSatang,
      marginSatang: costSatang === null ? null : collectedSatang - costSatang,
      billedCount: due.length,
      walkInCount: eligibleWalkIns.length,
    },
    warnings,
    shuttleAllocation: allocation,
  };
}

/**
 * Which way the shuttle cost is shared. Identity sharing needs every game's
 * log known and at least one referenced shuttle; otherwise the pre-D
 * equal-per-match split stands for the WHOLE session — never a mix of guessed
 * uses and known identities. A zero cost needs no fallback: every split of
 * zero is zero.
 */
function chooseShuttleAllocation(input: BillInput, shuttlesBilled: boolean, shuttleTotal: number): ShuttleAllocation {
  if (shuttlesBilled && input.config.shuttleSplit === 'equal') return 'equal';
  if (!shuttlesBilled || input.shuttleAllocation !== 'identities') return 'legacy-basic';
  if (input.matches.some((match) => !Array.isArray(match.shuttleIds))) return 'legacy-unknown';
  const referenced = input.matches.some((match) => (match.shuttleIds ?? []).length > 0);
  if (!referenced && shuttleTotal > 0) return 'legacy-no-uses';
  return 'identities';
}
