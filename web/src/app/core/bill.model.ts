export type BillModel = 'fair' | 'perGame' | 'buffet';
export type SplitMode = 'equal' | 'byGames';
export type RoundingStep = 1 | 5 | 10;
export type BillWarning = 'MISSING_COURT_FEE' | 'MISSING_SHUTTLE_COUNT' | 'MISSING_SHUTTLE_PRICE';
/** How shuttle cost was shared — mirrors engines/bill.ts. */
export type ShuttleAllocation = 'legacy-basic' | 'legacy-unknown' | 'legacy-no-uses' | 'identities' | 'equal';

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

export interface BillResponse {
  session: {
    code: string;
    date: string | null;
    venue: string | null;
    endedAt: string | null;
    shuttleCount: number | null;
    shuttlePriceSatang: number | null;
    /** This session's snapshot: true means shuttle use was tracked per game. */
    shuttleToolsEnabled: boolean;
  };
  config: BillConfig;
  configSource: 'saved' | 'previous' | 'default';
  players: { playerId: string; name: string; games: number; walkIn: boolean }[];
  result: BillResult;
  /** Where the billed shuttle count came from; the physical count is never rewritten. */
  accounting: {
    recordedFinishedShuttles: number;
    unknownFinishedMatches: number;
    /** Confirmed, finished games; 0 means no comparison with a physical count is meaningful yet. */
    finishedMatches: number;
    physicalCount: number | null;
    /** What was billed: physical if set, else the distinct shuttles in a complete log, else null. */
    effectiveCount: number | null;
    source: 'physical' | 'games' | 'missing' | 'ordinary';
    allocation: ShuttleAllocation;
  };
  /** False while a required input is missing for this model — final amounts must stay hidden and nothing may be copied. */
  readyToCopy: boolean;
}
