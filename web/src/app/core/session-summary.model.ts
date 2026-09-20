export interface SessionMatch {
  matchNumber: number;
  courtNumber: number;
  /** Null for a singles match — there is no partner to name. */
  partnerName: string | null;
  opponentNames: string[];
  scoreA: number | null;
  scoreB: number | null;
  result: 'win' | 'loss' | 'no-result';
  durationSeconds: number;
}

export interface FormatRecord {
  played: number;
  won: number;
  lost: number;
}

export interface PlayerSessionStat {
  playerId: string;
  name: string;
  played: number;
  won: number;
  lost: number;
  /** Sum of durationSeconds across this player's matches. */
  totalSeconds: number;
  /** Null when this player never played that format this session. */
  singles: FormatRecord | null;
  doubles: FormatRecord | null;
  matches: SessionMatch[];
}

export interface SessionSummary {
  session: {
    code: string;
    groupCode: string;
    date: string | null;
    venue: string | null;
    courtCount: number | null;
    endedAt: string | null;
  };
  players: PlayerSessionStat[];
}
