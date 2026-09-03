export interface MatchRecord {
  courtNumber: number;
  teamA: [string, string];
  teamB: [string, string];
  scoreA: number | null;
  scoreB: number | null;
}

export type CourtState =
  | { status: 'idle' }
  | { status: 'pending'; teamA: [string, string]; teamB: [string, string] }
  | { status: 'active'; teamA: [string, string]; teamB: [string, string] };
