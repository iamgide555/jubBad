// Type-only imports: engines/bill-breakdown.test.ts loads this file under node's
// strip-types to check it against the real engine, and that only works while
// nothing here pulls in a runtime module.
import type { BillConfig, BillRow } from './bill.model';

export type BreakdownKind =
  | 'court'
  | 'shuttle'
  | 'entry'
  | 'games'
  | 'cap'
  | 'startingFee'
  | 'buffet'
  | 'hostFee'
  | 'rounding'
  | 'walkInFee'
  | 'walkInDiscount';

export interface BreakdownLine {
  kind: BreakdownKind;
  /** Signed: discounts and a hit cap are negative, so the lines always add up. */
  amountSatang: number;
  /** `games` and a `full` shuttle charge: how many units at `rateSatang`. */
  count?: number;
  rateSatang?: number;
  /** `court` and `shuttle`: how the cost was shared. */
  split?: 'equal' | 'byGames' | 'shared';
}

export interface RowBreakdown {
  lines: BreakdownLine[];
  /** What the lines add up to: the row's amount, or what it would be without the override. */
  computedSatang: number;
  overridden: boolean;
}

/**
 * Explains one bill row: the engine's own sum
 * `ceil(base + hostFee) - walkInDiscount + walkInFee`, term by term, derived
 * from the row and config the page already has. Display only -- the engine
 * stays the single source of what a player owes.
 */
export function billBreakdown(row: BillRow, config: BillConfig, shuttlePriceSatang: number | null): RowBreakdown {
  if (row.status !== 'billed') return { lines: [], computedSatang: 0, overridden: false };
  const lines: BreakdownLine[] = [];
  const push = (line: BreakdownLine) => {
    if (line.amountSatang !== 0) lines.push(line);
  };

  switch (config.model) {
    case 'fair':
      // An absent player takes an equal court share whatever the split says.
      push({ kind: 'court', amountSatang: row.courtSatang, split: row.absent ? 'equal' : config.courtSplit });
      push({ kind: 'shuttle', amountSatang: row.shuttleSatang, split: config.shuttleSplit });
      break;
    case 'perGame': {
      const gamesSatang = row.games * config.perGameRateSatang;
      const raw = config.entryFeeSatang + gamesSatang;
      push({ kind: 'entry', amountSatang: config.entryFeeSatang });
      push({ kind: 'games', amountSatang: gamesSatang, count: row.games, rateSatang: config.perGameRateSatang });
      if (config.capSatang !== null && raw > config.capSatang) push({ kind: 'cap', amountSatang: config.capSatang - raw });
      break;
    }
    case 'perShuttle': {
      push({ kind: 'startingFee', amountSatang: config.startingFeeSatang });
      if (config.shuttleCharge === 'full') {
        const rate = config.perPlayerShuttleSatang ?? shuttlePriceSatang;
        push(
          rate
            ? { kind: 'shuttle', amountSatang: row.shuttleSatang, count: row.shuttleSatang / rate, rateSatang: rate }
            : { kind: 'shuttle', amountSatang: row.shuttleSatang }
        );
      } else {
        push({ kind: 'shuttle', amountSatang: row.shuttleSatang, split: 'shared' });
      }
      break;
    }
    case 'buffet':
      push({ kind: 'buffet', amountSatang: config.buffetPriceSatang });
      if (!config.buffetShuttlesIncluded) push({ kind: 'shuttle', amountSatang: row.shuttleSatang, split: config.shuttleSplit });
      break;
  }

  push({ kind: 'hostFee', amountSatang: row.hostFeeSatang });
  const step = config.roundingBaht * 100;
  const beforeRounding = row.baseSatang + row.hostFeeSatang;
  push({ kind: 'rounding', amountSatang: Math.ceil(beforeRounding / step) * step - beforeRounding });
  push({ kind: 'walkInFee', amountSatang: row.walkInFeeSatang });
  push({ kind: 'walkInDiscount', amountSatang: -row.walkInDiscountSatang });

  return { lines, computedSatang: lines.reduce((s, l) => s + l.amountSatang, 0), overridden: row.overridden };
}
