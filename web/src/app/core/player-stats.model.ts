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

export interface FormatRecord {
  played: number;
  won: number;
  winRate: number | null;
}

export interface PlayerProfile {
  playerId: string;
  name: string;
  played: number;
  won: number;
  /** null when they have not finished a match yet — not zero. */
  winRate: number | null;
  /** Doubles rating — the default format, and what most rows will be. */
  rating: number;
  /** Null when this player has never played singles, not 0/1200 — a group
   *  that never plays singles must see exactly today's profile. */
  singlesRating: number | null;
  /** Null when this player has never played that format — not a zeroed record. */
  singles: FormatRecord | null;
  doubles: FormatRecord | null;
  bestPartner: BestPartnerStat | null;
  mostFacedOpponent: PartnerStat | null;
}
