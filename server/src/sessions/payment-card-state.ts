/**
 * The only place Session.paymentCard is parsed or written. Tolerant on read:
 * a malformed column reads as the empty state and a bad field reads as null,
 * so a stored value can never break the payment card (same stance as
 * bill-config.ts). The account here is a snapshot taken when the host
 * confirms the card, so a later change to the group's account does not alter
 * a card already confirmed.
 */
import { randomBytes } from 'node:crypto';
import { payAccountFromUnknown, type PayAccount } from './pay-account.js';

export interface PaymentCardState {
  account: PayAccount | null;
  /** Credential for the public card link; random and unguessable, unlike the session code. */
  token: string | null;
  /** ISO timestamp of the host's confirmation, null until confirmed. */
  confirmedAt: string | null;
  /** Hash of the amounts and account the host confirmed, to tell when they have since changed. */
  confirmedHash: string | null;
  /** ISO timestamp of the last send to the LINE group, null if never sent. */
  lastSentAt: string | null;
  /** ISO timestamp of the last DM of the card to the host (`host` target), null if never; not part of the content hash. */
  lastDmAt: string | null;
}

/** Frozen: parsePaymentState hands this same object to every caller, so one must not be able to corrupt it. */
export const EMPTY_PAYMENT_STATE: PaymentCardState = Object.freeze({
  account: null,
  token: null,
  confirmedAt: null,
  confirmedHash: null,
  lastSentAt: null,
  lastDmAt: null,
});

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export function parsePaymentState(raw: string | null): PaymentCardState {
  if (raw === null) return EMPTY_PAYMENT_STATE;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return EMPTY_PAYMENT_STATE;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return EMPTY_PAYMENT_STATE;
  const o = v as Record<string, unknown>;
  return {
    account: payAccountFromUnknown(o['account']),
    token: str(o['token']),
    confirmedAt: str(o['confirmedAt']),
    confirmedHash: str(o['confirmedHash']),
    lastSentAt: str(o['lastSentAt']),
    lastDmAt: str(o['lastDmAt']),
  };
}

export function serializePaymentState(state: PaymentCardState): string {
  return JSON.stringify(state);
}

export function newShareToken(): string {
  return randomBytes(16).toString('base64url');
}
