export type BillModel = 'fair' | 'perGame' | 'buffet' | 'perShuttle';
/** What an early leaver can be charged under: never `fair`. */
export type CheckoutModel = Exclude<BillModel, 'fair'>;
export type SplitMode = 'equal' | 'byGames';
export type RoundingStep = 1 | 5 | 10;
export type BillWarning =
  | 'MISSING_COURT_FEE'
  | 'MISSING_SHUTTLE_COUNT'
  | 'MISSING_SHUTTLE_PRICE'
  | 'UNKNOWN_SHUTTLE_USE'
  | 'EXCESS_CREDIT'
  | 'UNCOVERED_COST'
  | 'UNRETURNED_SURCHARGE';
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
  /** perShuttle only: flat fee per person before their share of the recorded shuttles. */
  startingFeeSatang: number;
  /** perShuttle only: 'shared' splits the recorded shuttle cost; 'full' charges each player per distinct shuttle. */
  shuttleCharge: 'shared' | 'full';
  /** perShuttle + full only: charge per player per shuttle; null follows the session shuttle price. */
  perPlayerShuttleSatang: number | null;
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

/** An early checkout as frozen: read-only, never a still-due row. */
export interface SettledRow {
  id: string;
  playerId: string;
  name: string;
  model: CheckoutModel;
  amountSatang: number;
  settledAt: string;
}

export interface BillResult {
  /** People still due. */
  rows: BillRow[];
  totals: {
    /** Settled once plus still due. */
    collectedSatang: number;
    settledTotalSatang: number;
    stillDueSatang: number;
    /** Frozen payments beyond the cost they were credited against: a refund the host handles outside the app. */
    excessCreditSatang: number;
    /** Cost nobody still due is left to pay. */
    uncoveredCostSatang: number;
    /** Walk-in surcharge nobody eligible could take back. */
    unreturnedSurchargeSatang: number;
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
  /** Early checkouts (advanced sessions); empty otherwise. */
  settled: SettledRow[];
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
