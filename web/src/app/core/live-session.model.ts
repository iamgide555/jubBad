export type CourtState =
  | { status: 'idle' }
  | { status: 'pending'; pairingId: string; teamA: [string, string]; teamB: [string, string] }
  | { status: 'active'; pairingId: string; teamA: [string, string]; teamB: [string, string] };
