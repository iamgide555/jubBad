export interface PartnerStat {
  playerId: string;
  name: string;
  played: number;
  won: number;
}

export interface PlayerProfile {
  playerId: string;
  name: string;
  played: number;
  won: number;
  /** null when they have not finished a match yet — not zero. */
  winRate: number | null;
  rating: number;
  mostWinsWith: PartnerStat | null;
  mostFacedOpponent: PartnerStat | null;
}
