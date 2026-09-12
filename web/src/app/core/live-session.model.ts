export type CourtFormat = 'doubles' | 'singles';

export type CourtState =
  | { status: 'idle'; format: CourtFormat }
  | { status: 'pending'; pairingId: string; format: CourtFormat; teamA: string[]; teamB: string[] }
  | { status: 'active'; pairingId: string; format: CourtFormat; teamA: string[]; teamB: string[] };
