/** The host's side of slip payments. Mirrors the owner routes in server/src/sessions/slips. */

/** One person's paid mark: by a slip the bot matched, or by the host's own tick. */
export interface SlipPaidRow {
  playerId: string;
  source: 'slip' | 'host';
  /** ISO time the mark was written. */
  at: string;
  /** The slip credited an amount that no longer matches the player's current row. The mark stays; the host decides. */
  amountChangedSince: boolean;
}

export type SlipWaitingReason = 'unmapped' | 'amount' | 'date' | 'receiver' | 'unreadable' | 'stale' | 'collision';

/** A slip held for the host instead of marking anyone paid. */
export interface SlipWaiting {
  id: string;
  reason: SlipWaitingReason;
  displayName: string | null;
  pictureUrl: string | null;
  lineUserId: string;
  /** The one owed amount read from the slip, or null when none or several were found. */
  amountSatang: number | null;
  /** Only on a receiver mismatch: the receiver as read, so the host can fix the saved name. */
  receiverName: string | null;
  receiverTail: string | null;
  createdAt: string;
  /** Unpaid players whose row equals the slip's amount; every unpaid player when there is no amount. */
  candidatePlayerIds: string[];
}

/** A slip whose reference was already used in the group; it never pays anyone. */
export interface SlipDuplicate {
  id: string;
  displayName: string | null;
  lineUserId: string;
  referenceTail: string;
  originalPlayerIds: string[];
  createdAt: string;
}

/** A LINE account linked to a player. The account id never reaches the page. */
export interface SlipLink {
  playerId: string;
  displayName: string | null;
  linkedBy: 'self' | 'host';
}

export interface SlipHostPanel {
  paid: SlipPaidRow[];
  waiting: SlipWaiting[];
  duplicates: SlipDuplicate[];
  links: SlipLink[];
}

export interface SlipResolveBody {
  coversPlayerIds: string[];
  senderPlayerId?: string | null;
}

/** The 409 codes the host routes answer with. The page maps each to a Thai sentence, never shows the code. */
export type SlipHostConflict =
  | 'COVERS_REQUIRED'
  | 'PLAYER_NOT_ON_BILL'
  | 'ACCOUNT_ALREADY_LINKED'
  | 'PLAYER_NOT_IN_GROUP'
  | 'NAME_UPDATE_NOT_APPLICABLE'
  | 'PAY_ACCOUNT_INVALID';
