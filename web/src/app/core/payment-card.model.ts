import type { PayAccount } from './pay-account.service';

/** Where the card goes, by the summary card's rule; `null` hides the panel. */
export type PaymentTarget = 'group' | 'host';

/** What the server answers to a send tap. `sent` is the only success; `busy` is a double tap swallowed. */
export type PaymentSendOutcome = 'sent' | 'quota' | 'failed' | 'unavailable' | 'not-confirmed' | 'stale' | 'busy';

/** The bill screen's payment panel: exactly what the card would say, and where it stands. Mirrors the server. */
export interface PaymentCardPanel {
  target: PaymentTarget | null;
  ended: boolean;
  /** False while a blocking warning is in `warnings`; notices never block. */
  ready: boolean;
  /** The server's hash of what the card would print as read here; confirm sends it back as `expectedHash`. */
  contentHash: string;
  /** Every bill warning, blocking or not. */
  warnings: string[];
  /** The subset of `warnings` that only informs the host; the rest are the blocking ones. */
  notices: string[];
  /** The card's header texts exactly as the card prints them (group-name fallback, Thai date, clipped). */
  groupName: string;
  date: string;
  venue: string | null;
  /** People still due, sorted by name (the card's order too). */
  rows: { playerId: string; name: string; amountSatang: number; absent: boolean }[];
  settledCount: number;
  totalSatang: number;
  groupAccount: PayAccount | null;
  /** Tonight's account if one was confirmed, else the group default. */
  account: PayAccount | null;
  confirmed: boolean;
  /** Confirmed, but the card's content has changed since: confirm again before it goes out. */
  stale: boolean;
  lastSentAt: string | null;
  /** When the bot last DMed the card to the host (`host` target), null if never. */
  lastDmAt: string | null;
  /** The host-share link (`host` target only), set only while the confirmed card is current. */
  shareUrl: string | null;
}
