/** The LIFF id the pay page needs before any LINE identity exists. */
export interface SlipPayConfig {
  liffId: string;
}

export interface SlipPayClaimable {
  playerId: string;
  name: string;
}

/** What the pay page shows the viewing LINE account. `amountSatang` and `playerName` are null until the account is linked to a player. */
export interface SlipPayView {
  collectionClosed?: boolean;
  amountSatang: number | null;
  playerName: string | null;
  claimable: SlipPayClaimable[];
  accountName: string;
  alreadyPaid: boolean;
  /** The night the bill is for, as the payment card writes it; null when the session has no date. */
  sessionDate: string | null;
}

export type SlipPayClaimOutcome = 'linked' | 'player-taken' | 'account-already-linked' | 'not-on-bill';

export type SlipPayUploadOutcome = 'paid' | 'waiting' | 'duplicate' | 'not-slip';

/** The outcome only: why a slip was held is the host's to know, never the sender's. */
export interface SlipPayUploadResult {
  outcome: SlipPayUploadOutcome;
}

/** Minimal read-only projection; no host review details or LINE account identifiers. */
export interface PaymentStatusView {
  closedAt?: string | null;
  pendingSlipCount?: number;
  sessionDate: string | null;
  rows: { name: string; amountSatang: number; paid: boolean; pending?: boolean; amountChangedSince: boolean }[];
}
