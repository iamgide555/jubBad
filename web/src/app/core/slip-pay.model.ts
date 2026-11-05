/** The LIFF id the pay page needs before any LINE identity exists. */
export interface SlipPayConfig {
  liffId: string;
}

/** Whether the viewing LINE account is the bill's collector, who gets the payment panel instead of the read-only list. */
export interface SlipPayRole {
  collector: boolean;
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
  /** The viewer may undo their own pick and choose again. */
  canChange: boolean;
  /** The night the bill is for, as the payment card writes it; null when the session has no date. */
  sessionDate: string | null;
  /** The viewer's own slip for more than their share, waiting for them to say who it covers. Absent from an older API. */
  choice?: SlipPayChoice | null;
}

/** "Who does this slip cover": the unpaid people owing money, the viewer's own row first. */
export interface SlipPayChoice {
  amountSatang: number;
  ownPlayerId: string | null;
  options: { playerId: string; name: string; amountSatang: number }[];
}

/** `exceeds`: the picked total is over the slip amount (or nobody was picked). `gone`: nothing of the viewer's to cover. */
export type SlipPayCoverOutcome = 'paid' | 'gone' | 'exceeds' | 'already-paid' | 'not-on-bill';

export type SlipPayClaimOutcome = 'linked' | 'player-taken' | 'account-already-linked' | 'not-on-bill';

/** `locked`: the pick is no longer the player's to change (the host made the link, or a payment has proven it). */
export type SlipPayUnclaimOutcome = 'unlinked' | 'locked';

export type SlipPayUploadOutcome = 'paid' | 'waiting' | 'choose' | 'duplicate' | 'already-sent' | 'not-slip';

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
