/** The host's side of slip payments. Mirrors the owner routes in server/src/sessions/slips. */

/** One person's paid mark: by a slip the bot matched, or by the host's own tick. */
export interface SlipPaidRow {
  playerId: string;
  /** `owner`: the bill's เจ้าของบัญชี, paid without a mark because the money goes to them. Not tappable. */
  source: 'slip' | 'host' | 'collector' | 'owner';
  /** ISO time the mark was written. */
  at: string;
  /** The slip credited an amount that no longer matches the player's current row. The mark stays; the host decides. */
  amountChangedSince: boolean;
  /** The kept image of the slip behind a `slip` mark; null for a tick, or once the image is purged or expired. */
  imageId?: string | null;
}

export type SlipWaitingReason = 'unmapped' | 'amount' | 'date' | 'receiver' | 'unreadable' | 'stale' | 'collision' | 'undone' | 'overpaid';

/** A slip held for the host instead of marking anyone paid. */
export interface SlipWaiting {
  id: string;
  imageId?: string | null;
  linkedPlayerId?: string | null;
  reason: SlipWaitingReason;
  displayName: string | null;
  pictureUrl: string | null;
  /** Absent on the collector's panel: the account id never reaches the LINE page. */
  lineUserId?: string;
  /** The one owed amount read from the slip, or null when none or several were found. */
  amountSatang: number | null;
  /** Only on a receiver mismatch: the receiver as read, so the host can fix the saved name. */
  receiverName: string | null;
  receiverTail: string | null;
  createdAt: string;
  /** Unpaid players whose row equals the slip's amount; every unpaid player when there is no amount. */
  candidatePlayerIds: string[];
}

/** A slip the host rejected (ปฏิเสธ), kept so a mistaken rejection can be brought back until collection closes. */
export interface SlipSkipped {
  id: string;
  imageId: string | null;
  displayName: string | null;
  pictureUrl: string | null;
  amountSatang: number | null;
  createdAt: string;
  skippedAt: string;
}

/** A slip whose reference was already used in the group; it never pays anyone. */
export interface SlipDuplicate {
  id: string;
  displayName: string | null;
  lineUserId?: string;
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

/** What the awards card did when the collection closed; `skipped` is the host's own choice in the close dialog. */
export type AwardsCardOutcome = 'sent' | 'already-sent' | 'unavailable' | 'failed' | 'skipped';

/** Where the awards card would go on close: the LINE group, or the host's own LINE chat; null when nowhere. */
export type AwardsCardTarget = 'group' | 'host' | null;

/** The answer to a close; `card` is missing while an older API is still deployed. */
export type SlipCloseResult = { ok: true; card?: AwardsCardOutcome };

export interface SlipHostPanel {
  /** `card` is optional while an older API is still deployed. */
  collection?: { closedAt: string | null; canClose: boolean; imageCount: number; card?: AwardsCardTarget };
  paid: SlipPaidRow[];
  waiting: SlipWaiting[];
  /** Optional while an older API is still deployed. */
  skipped?: SlipSkipped[];
  duplicates: SlipDuplicate[];
  links: SlipLink[];
  /** Who receives the money when it is not the host, so the host sees the bill is managed in LINE. */
  collector?: { playerName: string; lineName: string | null } | null;
}

export interface SlipResolveBody {
  reviewedAmountSatang?: number;
  coversPlayerIds: string[];
  senderPlayerId?: string | null;
}

/** The 409 codes the host routes answer with. The page maps each to a Thai sentence, never shows the code. */
export type SlipHostConflict =
  | 'SLIP_AMOUNT_REQUIRED'
  | 'SLIP_AMOUNT_INVALID'
  | 'SLIP_AMOUNT_MISMATCH'
  | 'PLAYER_ALREADY_PAID'
  | 'COLLECTION_CLOSED'
  | 'COLLECTION_NOT_READY'
  | 'COVERS_REQUIRED'
  | 'PLAYER_NOT_ON_BILL'
  | 'ACCOUNT_ALREADY_LINKED'
  | 'PLAYER_NOT_IN_GROUP'
  | 'NAME_UPDATE_NOT_APPLICABLE'
  | 'PAY_ACCOUNT_INVALID';
