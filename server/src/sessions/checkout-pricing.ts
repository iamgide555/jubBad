/**
 * Records for early-leaver settlements (host feedback E). The ledger holds
 * money, so unlike most parsers in this codebase these fail loudly: a corrupt
 * breakdown or snapshot must never quietly read as zero and make a frozen
 * receipt look cheaper than what was quoted. The only place those JSON
 * columns are parsed or written.
 */

/** Where a settled amount came from, in integer satang. */
export interface CheckoutBreakdown {
  baseSatang: number;
  shuttleSatang: number;
  hostFeeSatang: number;
  walkInFeeSatang: number;
  /** The walk-in discount already returned inside this receipt, kept for later reconciliation. */
  discountSatang: number;
}

/** The normalized inputs a receipt was priced from, for audit and stale detection. */
export interface CheckoutSnapshot {
  version: 1;
  /** Hash of every effective input at settlement; a later preview with a different hash is stale. */
  hash: string;
  games: number;
  /** Engine ids of the distinct shuttles this player's finished games used (recorded, never guessed). */
  shuttleIds: string[];
  shuttlePriceSatang: number | null;
  walkIn: boolean;
}

const BREAKDOWN_KEYS = ['baseSatang', 'shuttleSatang', 'hostFeeSatang', 'walkInFeeSatang', 'discountSatang'] as const;
const MAX = 2147483647;

const isSatang = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX;

function parseObject(raw: string, what: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error(`checkout ${what} is not valid JSON`);
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`checkout ${what} is not an object`);
  return v as Record<string, unknown>;
}

export function parseCheckoutBreakdown(raw: string): CheckoutBreakdown {
  const o = parseObject(raw, 'breakdown');
  const out = {} as Record<string, number>;
  for (const key of BREAKDOWN_KEYS) {
    const v = o[key];
    if (!isSatang(v)) throw new Error(`checkout breakdown ${key} must be a non-negative integer, got ${String(v)}`);
    out[key] = v;
  }
  return out as unknown as CheckoutBreakdown;
}

export function serializeCheckoutBreakdown(b: CheckoutBreakdown): string {
  return JSON.stringify(parseCheckoutBreakdown(JSON.stringify(b)));
}

export function parseCheckoutSnapshot(raw: string): CheckoutSnapshot {
  const o = parseObject(raw, 'snapshot');
  if (o['version'] !== 1) throw new Error(`checkout snapshot version ${String(o['version'])} is not supported`);
  if (typeof o['hash'] !== 'string' || o['hash'] === '') throw new Error('checkout snapshot hash is missing');
  if (!Number.isInteger(o['games']) || (o['games'] as number) < 0) throw new Error('checkout snapshot games must be a non-negative integer');
  const ids = o['shuttleIds'];
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string')) throw new Error('checkout snapshot shuttleIds must be strings');
  const price = o['shuttlePriceSatang'];
  if (price !== null && !isSatang(price)) throw new Error('checkout snapshot shuttlePriceSatang must be a non-negative integer or null');
  if (typeof o['walkIn'] !== 'boolean') throw new Error('checkout snapshot walkIn must be a boolean');
  return {
    version: 1,
    hash: o['hash'],
    games: o['games'] as number,
    shuttleIds: ids as string[],
    shuttlePriceSatang: price as number | null,
    walkIn: o['walkIn'],
  };
}

export function serializeCheckoutSnapshot(s: CheckoutSnapshot): string {
  return JSON.stringify(parseCheckoutSnapshot(JSON.stringify(s)));
}

/** The players with a current settlement: an undone entry no longer counts. */
export function activeCheckouts(rows: readonly { playerId: string; undoneAt: Date | null }[]): Set<string> {
  return new Set(rows.filter((r) => r.undoneAt === null).map((r) => r.playerId));
}
