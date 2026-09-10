export interface SessionMatch {
  matchNumber: number;
  courtNumber: number;
  partnerName: string;
  opponentNames: [string, string];
  scoreA: number | null;
  scoreB: number | null;
  result: 'win' | 'loss' | 'no-result';
}

export interface PlayerSessionStat {
  playerId: string;
  name: string;
  played: number;
  won: number;
  lost: number;
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
