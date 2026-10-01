/**
 * Pure early-checkout pricing (host feedback E). Quotes one player who leaves
 * before the night ends from the games finished so far, under one of three
 * models, in integer satang. No database, no framework: the server passes in
 * what it read and freezes what this returns.
 *
 * Shuttle cost is the recorded cost only -- distinct shuttle identities times
 * the session price -- never the physical count. A physical shuttle reused
 * across games is priced once, split game by game then player by player
 * exactly as the whole-session bill does (bill.ts costShares), so a quote
 * agrees with the final bill when nobody has left yet.
 */
import {
  BILL_MODELS,
  ROUNDING_STEPS,
  splitByWeight,
  splitEqual,
  type BillConfig,
  type BillMatch,
  type CheckoutModel,
} from './bill.ts';

/** What other people already paid at checkout; only the amount matters to a quote. */
export interface SettledReceipt {
  playerId: string;
  amountSatang: number;
  walkInFeeSatang: number;
  walkInDiscountSatang: number;
  /** The starting fee a perShuttle receipt embeds: the host's flat charge, not money toward shuttles. */
  startingFeeSatang?: number;
}

export interface CheckoutPreviewInput {
  playerId: string;
  model: CheckoutModel;
  config: BillConfig;
  /** Finished games only. */
  matches: BillMatch[];
  shuttlePriceSatang: number | null;
  walkInIds: string[];
  /** Current (not undone) receipts of everyone else. */
  otherSettled: SettledReceipt[];
}

export interface CheckoutPreview {
  model: CheckoutModel;
  amountSatang: number;
  /** Finished games this player was in. */
  games: number;
  breakdown: {
    baseSatang: number;
    shuttleSatang: number;
    hostFeeSatang: number;
    walkInFeeSatang: number;
    /** Always 0 in an early receipt: the leaver's own surcharge is redistributed at the final bill. */
    discountSatang: number;
  };
}

/** A missing fact the chosen model needs; blocks the quote rather than guessing it. */
export class CheckoutBlockedError extends Error {
  readonly code: 'UNKNOWN_SHUTTLE_USE' | 'MISSING_SHUTTLE_PRICE';
  constructor(code: CheckoutBlockedError['code']) {
    super(
      code === 'UNKNOWN_SHUTTLE_USE'
        ? 'checkout: a finished game of this player has unknown shuttle use; correct it first'
        : 'checkout: missing shuttle price; set it before pricing recorded shuttles'
    );
    this.name = 'CheckoutBlockedError';
    this.code = code;
  }
}

const isSatang = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

function assertMoney(label: string, v: number | null): void {
  if (v !== null && !isSatang(v)) throw new Error(`checkout: ${label} must be a non-negative integer, got ${v}`);
}

const ceilTo = (amount: number, step: number): number => Math.ceil(amount / step) * step;

/**
 * This player's share of the recorded shuttle cost. The identity/game/player
 * split gives every participant a nominal share; whatever earlier leavers
 * already paid is credited against the total, and the rest is divided among
 * the people still unsettled in proportion to those nominal shares. With
 * nobody settled this is exactly the whole-session split.
 */
function shuttleShare(input: CheckoutPreviewInput, priceSatang: number): number {
  const { matches, playerId, otherSettled } = input;
  const ids = [...new Set(matches.flatMap((m) => m.shuttleIds ?? []))].sort();
  const cost = ids.length * priceSatang;
  const nominal = new Map<string, number>();
  const perId = splitEqual(cost, ids.length);
  ids.forEach((shuttleId, k) => {
    const using = matches.filter((m) => m.shuttleIds?.includes(shuttleId));
    const perGame = splitEqual(perId[k], using.length);
    using.forEach((m, g) => {
      splitEqual(perGame[g], m.players.length).forEach((v, j) => {
        nominal.set(m.players[j], (nominal.get(m.players[j]) ?? 0) + v);
      });
    });
  });
  const settled = new Set(otherSettled.map((r) => r.playerId));
  const credit = otherSettled.reduce((s, r) => s + r.amountSatang - (r.startingFeeSatang ?? 0), 0);
  const unsettled = [...nominal.keys()].filter((id) => !settled.has(id) || id === playerId).sort();
  const shares = splitByWeight(Math.max(0, cost - credit), unsettled.map((id) => nominal.get(id)!));
  return shares[unsettled.indexOf(playerId)] ?? 0;
}

export function computeCheckoutPreview(input: CheckoutPreviewInput): CheckoutPreview {
  const { config, model, playerId, matches } = input;
  if (!BILL_MODELS.includes(model) || model === ('fair' as string)) {
    throw new Error(`checkout: model ${model} cannot be quoted mid-session`);
  }
  if (!ROUNDING_STEPS.includes(config.roundingBaht)) throw new Error(`checkout: unknown rounding ${config.roundingBaht}`);
  for (const [label, v] of [
    ['perGameRateSatang', config.perGameRateSatang],
    ['entryFeeSatang', config.entryFeeSatang],
    ['capSatang', config.capSatang],
    ['buffetPriceSatang', config.buffetPriceSatang],
    ['startingFeeSatang', config.startingFeeSatang],
    ['hostFeeSatang', config.hostFeeSatang],
    ['walkInFeeSatang', config.walkInFeeSatang],
    ['shuttlePriceSatang', input.shuttlePriceSatang],
  ] as const) {
    assertMoney(label, v);
  }
  for (const r of input.otherSettled) assertMoney(`settled ${r.playerId}`, r.amountSatang);

  const own = matches.filter((m) => m.players.includes(playerId));
  const games = own.length;
  const step = config.roundingBaht * 100;
  const override = config.overrides.find((o) => o.playerId === playerId);
  const zero = { baseSatang: 0, shuttleSatang: 0, hostFeeSatang: 0, walkInFeeSatang: 0, discountSatang: 0 };
  if (override) return { model, amountSatang: override.amountSatang, games, breakdown: { ...zero, baseSatang: override.amountSatang } };

  const pricesShuttles = model === 'perShuttle' || (model === 'buffet' && !config.buffetShuttlesIncluded);
  let shuttleSatang = 0;
  if (pricesShuttles) {
    if (own.some((m) => !Array.isArray(m.shuttleIds))) throw new CheckoutBlockedError('UNKNOWN_SHUTTLE_USE');
    if (own.some((m) => (m.shuttleIds ?? []).length > 0)) {
      if (input.shuttlePriceSatang === null) throw new CheckoutBlockedError('MISSING_SHUTTLE_PRICE');
      shuttleSatang = shuttleShare(input, input.shuttlePriceSatang);
    }
  }

  let baseSatang: number;
  if (model === 'perGame') {
    const raw = config.entryFeeSatang + games * config.perGameRateSatang;
    baseSatang = config.capSatang === null ? raw : Math.min(raw, config.capSatang);
  } else if (model === 'perShuttle') baseSatang = config.startingFeeSatang;
  else baseSatang = config.buffetPriceSatang;

  const feeSteps = config.walkInFeeSatang === 0 ? 0 : Math.ceil(config.walkInFeeSatang / step);
  const walkInFeeSatang = input.walkInIds.includes(playerId) ? feeSteps * step : 0;
  const amountSatang = ceilTo(baseSatang + shuttleSatang + config.hostFeeSatang, step) + walkInFeeSatang;
  return {
    model,
    amountSatang,
    games,
    breakdown: { baseSatang, shuttleSatang, hostFeeSatang: config.hostFeeSatang, walkInFeeSatang, discountSatang: 0 },
  };
}
