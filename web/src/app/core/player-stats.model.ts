export interface PartnerStat {
  playerId: string;
  name: string;
  played: number;
  won: number;
}

export interface BestPartnerStat extends PartnerStat {
  /** Over decisive games only; null when none have had a result yet. */
  winRate: number | null;
  /**
   * True when no pairing has reached the minimum games together yet, so this
   * is the most-wins partner standing in rather than a trusted rate.
   */
  provisional: boolean;
}

export interface PlayerProfile {
  playerId: string;
  name: string;
  played: number;
  won: number;
  /** null when they have not finished a match yet — not zero. */
  winRate: number | null;
  rating: number;
  bestPartner: BestPartnerStat | null;
  mostFacedOpponent: PartnerStat | null;
}
