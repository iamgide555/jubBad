/**
 * The only place Session.billConfig is parsed or written. Tolerant on read:
 * a malformed column reads as null and a bad field reads as its default, so
 * a stored value can never break GET /bill (same stance as court-formats.ts).
 * Strict validation of new input happens in SetBillConfigDto and the engine.
 */
import {
  BILL_MODELS,
  DEFAULT_BILL_CONFIG,
  ROUNDING_STEPS,
  SPLIT_MODES,
  type BillConfig,
  type BillOverride,
} from '../../../engines/bill.ts';

const MAX = 2147483647;
const isMoney = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX;
const pick = <T>(v: unknown, ok: (x: unknown) => boolean, fallback: T): T => (ok(v) ? (v as T) : fallback);
const nullableMoney = (v: unknown, fallback: number | null): number | null =>
  v === null ? null : isMoney(v) ? v : fallback;
const ids = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x !== ''))] : [];

export function parseBillConfig(raw: string | null): BillConfig | null {
  if (raw === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const d = DEFAULT_BILL_CONFIG;
  const seen = new Set<string>();
  const overrides: BillOverride[] = [];
  if (Array.isArray(o['overrides'])) {
    for (const x of o['overrides']) {
      const e = x as Partial<BillOverride> | null;
      if (e && typeof e.playerId === 'string' && e.playerId !== '' && isMoney(e.amountSatang) && !seen.has(e.playerId)) {
        seen.add(e.playerId);
        overrides.push({ playerId: e.playerId, amountSatang: e.amountSatang });
      }
    }
  }
  return {
    model: pick(o['model'], (x) => (BILL_MODELS as readonly unknown[]).includes(x), d.model),
    courtFeeSatang: nullableMoney(o['courtFeeSatang'], d.courtFeeSatang),
    courtSplit: pick(o['courtSplit'], (x) => (SPLIT_MODES as readonly unknown[]).includes(x), d.courtSplit),
    shuttleSplit: pick(o['shuttleSplit'], (x) => (SPLIT_MODES as readonly unknown[]).includes(x), d.shuttleSplit),
    perGameRateSatang: pick(o['perGameRateSatang'], isMoney, d.perGameRateSatang),
    entryFeeSatang: pick(o['entryFeeSatang'], isMoney, d.entryFeeSatang),
    capSatang: nullableMoney(o['capSatang'], d.capSatang),
    buffetPriceSatang: pick(o['buffetPriceSatang'], isMoney, d.buffetPriceSatang),
    buffetShuttlesIncluded: pick(o['buffetShuttlesIncluded'], (x) => typeof x === 'boolean', d.buffetShuttlesIncluded),
    hostFeeSatang: pick(o['hostFeeSatang'], isMoney, d.hostFeeSatang),
    walkInFeeSatang: pick(o['walkInFeeSatang'], isMoney, d.walkInFeeSatang),
    roundingBaht: pick(o['roundingBaht'], (x) => (ROUNDING_STEPS as readonly unknown[]).includes(x), d.roundingBaht),
    addedIds: ids(o['addedIds']),
    removedIds: ids(o['removedIds']),
    overrides,
  };
}

export function serializeBillConfig(c: BillConfig): string {
  return JSON.stringify(c);
}

/** For prefilling a new session from the previous one: rates and toggles carry over, people don't. */
export function withoutPerPerson(c: BillConfig): BillConfig {
  return { ...c, addedIds: [], removedIds: [], overrides: [] };
}

export function sanitizeForRoster(c: BillConfig, rosterIds: string[]): BillConfig {
  const on = new Set(rosterIds);
  return {
    ...c,
    addedIds: c.addedIds.filter((id) => on.has(id)),
    removedIds: c.removedIds.filter((id) => on.has(id)),
    overrides: c.overrides.filter((o) => on.has(o.playerId)),
  };
}
